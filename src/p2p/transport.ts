/** p2p/transport.ts — the iroh peer transport: endpoint lifecycle, dial-by-key, request framing. See wire-protocol.md. */
import { Endpoint, EndpointAddr, EndpointId, RelayMode, presetMinimal, type Connection } from '@number0/iroh';
import { CFG, log, trace } from '../config.ts';
import { keys, save } from '../state.ts';
import type { Peer } from '../store.ts';

// The ALPN carries the protocol MAJOR. v1 serves exactly ['isa/2']; a future v3 keeps
// serving old ALPNs one major back and prefers the newest the dialer offers — the accept
// loop reads the NEGOTIATED alpn per connection, so dual-serving needs no flag day.
export const PROTOCOL_ALPN = Array.from(Buffer.from('isa/2'));
export const SERVED_ALPNS = [PROTOCOL_ALPN];

/** Reject a hung request instead of blocking a sync loop forever — a v0-style peer that
 *  abandons a stream mid-request must cost one timeout, not a wedged process. */
const DEADLINE_MS = 120_000;
/** Reaching a peer is a different budget from streaming a body. A dial either completes in a
 *  few seconds (direct, hole-punched, or via the relay) or the peer is not there; QUIC's own
 *  give-up is ~45s and the stream deadline above is two minutes, and until this existed an
 *  OFFLINE owner made every uncached photo hang in the member's Immich for that long before
 *  the local stub was served. The byte path fails closed to the stub in seconds instead. */
const DIAL_DEADLINE_MS = 10_000;
/** The byte path's response HEADER — see peerByteRequest. Bodies keep DEADLINE_MS semantics
 *  (none: they stream to FIN). JSON requests keep DEADLINE_MS for their header too, because a
 *  ref push is processed before it is answered and can legitimately take that long — a DEAD
 *  connection is caught by untilClosed instead, not by shortening that deadline. */
const BYTE_HEAD_DEADLINE_MS = 15_000;
export const withDeadline = <T>(p: Promise<T>, what: string, ms = DEADLINE_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
};

/** Race a wait against the peer's connection dying.
 *
 *  TCP told the v1 HTTP transport when a peer had restarted: the socket failed, the request
 *  failed with it, and the next call dialled fresh. QUIC does not — `closeReason()` stays null
 *  on a connection whose peer is already gone, so a request written into it waits out its whole
 *  deadline. `closed()` is the one signal that does fire, so every wait that can span a restart
 *  races against it. */
const closedOnce = new WeakMap<Connection, Promise<string>>();
/** One `closed()` promise per connection. Asking per request would register an observer per request,
 *  and a CACHED connection holds every one of them for as long as it lives — a leak that grows with
 *  the number of requests served over it. */
const whenClosed = (conn: Connection): Promise<string> => {
  let closed = closedOnce.get(conn);
  if (!closed) {
    try {
      closed = Promise.resolve(conn.closed());
    } catch {
      closed = Promise.reject(new Error('unavailable'));
    }
    closed.catch(() => {}); // every racer observes it; never an unhandled rejection
    closedOnce.set(conn, closed);
  }
  return closed;
};

const untilClosed = <T>(conn: Connection, p: Promise<T>, what: string): Promise<T> => {
  return Promise.race([
    p,
    whenClosed(conn)
      .catch(() => 'peer gone')
      .then((reason: string) => {
        throw new Error(`connection closed before ${what}${reason ? `: ${reason}` : ''}`);
      }),
  ]);
};

/** Log a connection's death and how long after the request began it happened. */
function traceConnectionDeath(conn: Connection, started: number, what: string): void {
  if (!CFG.traceSync) return;
  void whenClosed(conn)
    .then((reason: string) =>
      trace(`${what} connection CLOSED after ${Date.now() - started}ms — ${reason || 'no reason given'}`)
    )
    .catch(() => {});
}

/** True when the peer's connection died mid-request rather than our own deadline expiring. */
const connectionDied = (e: unknown): boolean =>
  e instanceof Error && e.message.startsWith('connection closed before');

// Identity strings are RAW ed25519 keys, base64url — byte-for-byte what iroh speaks, so
// these two are pure encoding shifts, not format conversions.
export const pubToRaw = (pubB64: string): number[] => Array.from(Buffer.from(pubB64, 'base64url'));
export const rawToPub = (raw: number[] | Uint8Array): string =>
  Buffer.from(raw as Uint8Array).toString('base64url');

const secretSeed = (): number[] => Array.from(Buffer.from(keys.priv, 'base64url'));

// ---- framing: one bi-stream per request ----
// request  = u32-LE header length, JSON { path, range? }, u32-LE body length, body bytes
// response = u32-LE header length, JSON { status, headers? }, body bytes until FIN
// `mapping` is ADVISORY in protocol 2: senders include the mapping id they believe scopes
// a byte request, receivers ignore it. Carried now so a future major can enforce per-share
// entitlement without adding a required field (which would be wire-breaking).
type FrameHeader = { path: string; range?: string; mapping?: string };
type ResponseHeader = { status: number; headers?: Record<string, string> };

const lenPrefixed = (payload: Buffer): number[] => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length);
  return Array.from(Buffer.concat([len, payload]));
};

const readPrefixed = async (
  recv: { readExact(size: number): Promise<number[]> },
  limit: number
): Promise<Buffer> => {
  const len = Buffer.from(await recv.readExact(4)).readUInt32LE();
  if (len > limit) throw new Error(`frame of ${len} bytes exceeds the ${limit}-byte limit`);
  return len === 0 ? Buffer.alloc(0) : Buffer.from(await recv.readExact(len));
};

/**
 * Read a length-prefixed frame, or CONSUME an over-limit one and report it. The stream must
 * be fully drained before we answer: tearing down a half-read stream (with or without an
 * explicit stop) has killed the whole process inside the native layer. The drain is capped —
 * a hostile multi-GB declaration costs us the capped read, then the connection.
 */
const DRAIN_MAX = 64 * 1024 * 1024;
const readFrameOrDrain = async (
  recv: { read(size: number): Promise<number[]>; readExact(size: number): Promise<number[]> },
  limit: number
): Promise<{ ok: true; data: Buffer } | { ok: false; declared: number }> => {
  const len = Buffer.from(await recv.readExact(4)).readUInt32LE();
  if (len <= limit)
    return { ok: true, data: len === 0 ? Buffer.alloc(0) : Buffer.from(await recv.readExact(len)) };
  let left = Math.min(len, DRAIN_MAX);
  try {
    while (left > 0) {
      const chunk = await recv.read(Math.min(left, 256 * 1024));
      if (!chunk || chunk.length === 0) break;
      left -= chunk.length;
    }
  } catch {
    /* sender reset their side — equally fully closed, which is all the drain is for */
  }
  return { ok: false, declared: len };
};

export type PeerHandler = (
  callerPub: string,
  path: string,
  body: Buffer,
  range?: string
) => Promise<{ status: number; headers?: Record<string, string>; body?: Buffer | AsyncIterable<Buffer> }>;

let endpoint: Endpoint | null = null;

export const localAddr = () => {
  if (!endpoint) throw new Error('transport not started');
  return endpoint.addr();
};

export async function startTransport(handler: PeerHandler): Promise<void> {
  const builder = Endpoint.builder();
  presetMinimal(builder);
  // A stable UDP port (see CFG.p2pPort): peers remember ip:port, and a restart must not make
  // that memory wrong. 0 keeps iroh's random port for the rare host where the fixed one is taken.
  if (CFG.p2pPort) builder.bindAddr(`0.0.0.0:${CFG.p2pPort}`);
  // Relays assist hole-punching and carry end-to-end-encrypted traffic when a direct path
  // fails — the one disclosed third party, and only ever a fallback. ISA_RELAY=off runs dark.
  if (CFG.relay) builder.relayMode(RelayMode.defaultMode());
  builder.alpns(SERVED_ALPNS);
  builder.secretKey(secretSeed());
  endpoint = await builder.bind();
  log(`iroh transport listening — endpoint ${endpoint.id().toString().slice(0, 10)}…`);
  void acceptLoop(handler);
}

async function acceptLoop(handler: PeerHandler): Promise<void> {
  while (endpoint) {
    let incoming;
    try {
      incoming = await endpoint.acceptNext();
    } catch (e) {
      log('transport accept error:', (e as Error).message);
      continue;
    }
    if (!incoming) return;
    void serveConnection(incoming, handler).catch(e => log('peer connection error:', e.message));
  }
}

async function serveConnection(
  incoming: { accept(): Promise<{ connect(): Promise<any> }> },
  handler: PeerHandler
) {
  const conn = await (await incoming.accept()).connect();
  const callerPub = rawToPub(conn.remoteId().toBytes());
  for (;;) {
    let bi;
    try {
      bi = await conn.acceptBi();
    } catch {
      return; // connection closed — the dialer owns reconnects
    }
    void serveRequest(bi, callerPub, handler).catch(e => log('peer request error:', e.message));
  }
}

async function serveRequest(
  bi: { send: any; recv: any },
  callerPub: string,
  handler: PeerHandler
): Promise<void> {
  // Over-limit frames are DRAINED and ANSWERED — never abandoned (the sender would wait out
  // its deadline with nothing to act on) and never left half-read (see readFrameOrDrain).
  const answer = async (status: number, obj: unknown) => {
    await bi.send.writeAll(lenPrefixed(Buffer.from(JSON.stringify({ status, headers: {} }))));
    await bi.send.writeAll(Array.from(Buffer.from(JSON.stringify(obj))));
    await bi.send.finish();
  };
  const rawHeader = await readFrameOrDrain(bi.recv, 64 * 1024);
  if (!rawHeader.ok)
    return answer(431, { error: `${rawHeader.declared}-byte header`, code: 'header_too_large' });
  const header = JSON.parse(rawHeader.data.toString()) as FrameHeader;
  const rawBody = await readFrameOrDrain(bi.recv, CFG.maxBodyKb * 1024);
  if (!rawBody.ok)
    return answer(413, {
      error: `frame of ${rawBody.declared} bytes exceeds the ${CFG.maxBodyKb * 1024}-byte limit`,
      code: 'body_too_large',
    });
  const res = await handler(callerPub, header.path, rawBody.data, header.range);
  const head: ResponseHeader = { status: res.status, headers: res.headers };
  await bi.send.writeAll(lenPrefixed(Buffer.from(JSON.stringify(head))));
  if (res.body) {
    if (Buffer.isBuffer(res.body)) {
      if (res.body.length) await bi.send.writeAll(Array.from(res.body));
    } else {
      for await (const chunk of res.body) await bi.send.writeAll(Array.from(chunk));
    }
  }
  await bi.send.finish();
}

// ---- client side ----

const connections = new Map<string, Promise<Connection>>();

async function dial(peer: Peer): Promise<Connection> {
  const id = EndpointId.fromBytes(pubToRaw(peer.pub));
  const addr = new EndpointAddr(id, peer.relayHint ?? null, peer.lastAddrs ?? null);
  const conn = await endpoint!.connect(addr, PROTOCOL_ALPN);
  // Remember where they actually were, so the next dial after a restart has a live hint.
  const seen = await endpoint!.remoteAddr(id);
  if (seen) {
    peer.lastAddrs = seen.directAddresses();
    peer.relayHint = seen.relayUrl() ?? peer.relayHint;
    save();
  }
  return conn;
}

async function connectionFor(peer: Peer): Promise<Connection> {
  const started = Date.now();
  const cached = connections.get(peer.pub);
  if (cached) {
    try {
      const conn = await withDeadline(cached, `cached connection to "${peer.name}"`, DIAL_DEADLINE_MS);
      if (conn.closeReason() === null) {
        trace(`dial ${peer.name}: reusing cached connection (${Date.now() - started}ms)`);
        return conn;
      }
      trace(`dial ${peer.name}: cached connection closed (${conn.closeReason()}) — redialing`);
    } catch (e) {
      trace(`dial ${peer.name}: cached dial unusable (${(e as Error).message}) — redialing`);
    }
    connections.delete(peer.pub);
  }
  trace(`dial ${peer.name}: dialing`);
  const fresh = dial(peer);
  connections.set(peer.pub, fresh);
  fresh.catch(() => connections.delete(peer.pub));
  const conn = await fresh;
  trace(`dial ${peer.name}: dialed (${Date.now() - started}ms)`);
  return conn;
}

async function roundTrip(peer: Peer, header: FrameHeader, body: Buffer) {
  if (!endpoint) throw new Error('transport not started');
  const started = Date.now();
  try {
    const conn = await withDeadline(connectionFor(peer), `dial to "${peer.name}"`, DIAL_DEADLINE_MS);
    traceConnectionDeath(conn, started, `→ ${peer.name} ${header.path}:`);
    const bi = await untilClosed(conn, conn.openBi(), `opening a stream to "${peer.name}"`);
    trace(`→ ${peer.name} ${header.path}: stream open (${Date.now() - started}ms)`);
    await untilClosed(
      conn,
      (async () => {
        await bi.send.writeAll(lenPrefixed(Buffer.from(JSON.stringify(header))));
        await bi.send.writeAll(lenPrefixed(body));
        await bi.send.finish();
      })(),
      `sending ${header.path} to "${peer.name}"`
    );
    trace(`→ ${peer.name} ${header.path}: sent ${body.length}B (${Date.now() - started}ms)`);
    return { bi, conn, started };
  } catch (e) {
    connections.delete(peer.pub); // a timed-out or broken connection must not be reused
    trace(
      `→ ${peer.name} ${header.path}: SEND FAILED after ${Date.now() - started}ms — ${(e as Error).message}`
    );
    throw e;
  }
}

/** Run a request, and on a connection death re-dial ONCE and run it again. The peer restarted and
 *  the request may or may not have been processed, so this is offered only to requests that carry
 *  no body — see the note at the call site. */
async function withRedialOnDeath<T>(peer: Peer, what: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!connectionDied(e)) throw e;
    connections.delete(peer.pub); // it is gone; a fresh dial is the only way through
    trace(`${what}: ${(e as Error).message} — redialing once`);
    return attempt();
  }
}

/** JSON request/response with a peer. Mirrors the old signedFetch/signedGet call sites. */
export async function peerRequest(
  peer: Peer,
  path: string,
  jsonBody?: unknown
): Promise<{ status: number; json: any }> {
  const body = jsonBody === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(jsonBody));
  const attempt = async () => {
    const { bi, conn, started } = await roundTrip(peer, { path }, body);
    try {
      trace(`← ${peer.name} ${path}: awaiting response header (${Date.now() - started}ms)`);
      const head = JSON.parse(
        (
          await untilClosed(
            conn,
            withDeadline(readPrefixed(bi.recv, 64 * 1024), `response from "${peer.name}"`),
            `the response header for ${path} from "${peer.name}"`
          )
        ).toString()
      ) as ResponseHeader;
      trace(`← ${peer.name} ${path}: header ${head.status} (${Date.now() - started}ms)`);
      const raw = Buffer.from(
        await untilClosed(
          conn,
          withDeadline(bi.recv.readToEnd(64 * 1024 * 1024), `response body from "${peer.name}"`),
          `the response body for ${path} from "${peer.name}"`
        )
      );
      trace(`← ${peer.name} ${path}: body ${raw.length}B (${Date.now() - started}ms)`);
      return { status: head.status, json: raw.length ? JSON.parse(raw.toString()) : null };
    } catch (e) {
      connections.delete(peer.pub); // a connection that stopped answering must not be reused
      trace(
        `← ${peer.name} ${path}: RECEIVE FAILED after ${Date.now() - started}ms — ${(e as Error).message}`
      );
      throw e;
    }
  };
  // REDIAL ONLY A REQUEST THAT CARRIED NO BODY. A body means the peer may already have acted on it
  // before the connection died, and repeating it is not free: `materialiseRef` records its checksum
  // only AFTER the upload and the album add, so a second `/refs` can add a second stub — with a
  // random tail, which is exactly what stops Immich collapsing the two. A bodyless request is a read
  // and safe to repeat; anything else is left to the caller, which knows what it has recorded.
  return jsonBody === undefined ? withRedialOnDeath(peer, `${path} to ${peer.name}`, attempt) : attempt();
}

/** Byte request with a peer — previews, originals, playback. Range rides the frame header. */
export async function peerByteRequest(
  peer: Peer,
  path: string,
  range?: string,
  mapping?: string
): Promise<{
  status: number;
  headers: Record<string, string>;
  recv: { read(size: number): Promise<number[]> };
}> {
  const { bi, conn, started } = await roundTrip(peer, { path, range, mapping }, Buffer.alloc(0));
  // Deadline covers the header only: byte BODIES may stream for as long as a video runs. The
  // header gets the SHORT budget: a peer answers a byte request the moment its Immich returns
  // headers, so a header that has not arrived in seconds means the peer is gone — and a cached
  // QUIC connection to a peer that died without closing still looks open (closeReason() null),
  // so the dial deadline never fires for it; QUIC's own loss detection takes ~45s. This is the
  // wait a member's Immich showed on every uncached photo while the owner was offline.
  // No redial here: this path already fails closed to the local stub in seconds, and a dial
  // would only delay that stub.
  let head: ResponseHeader;
  try {
    head = JSON.parse(
      (
        await untilClosed(
          conn,
          withDeadline(
            readPrefixed(bi.recv, 64 * 1024),
            `byte response from "${peer.name}"`,
            BYTE_HEAD_DEADLINE_MS
          ),
          `the byte response header for ${path} from "${peer.name}"`
        )
      ).toString()
    ) as ResponseHeader;
  } catch (e) {
    // A header that never came means the connection is dead even though QUIC has not said so
    // yet. Evict it, or every request until QUIC's own loss detection would time out the same
    // way — including the first one after the peer comes back.
    connections.delete(peer.pub);
    trace(
      `← ${peer.name} ${path}: BYTE HEADER FAILED after ${Date.now() - started}ms — ${(e as Error).message}`
    );
    throw e;
  }
  trace(`← ${peer.name} ${path}: byte header ${head.status} (${Date.now() - started}ms)`);
  return { status: head.status, headers: head.headers ?? {}, recv: bi.recv };
}

/** Adapt a peer recv stream into chunks; read() returns an empty array at FIN (spiked). */
export async function* recvIterable(recv: { read(size: number): Promise<number[]> }): AsyncIterable<Buffer> {
  for (;;) {
    const chunk = await recv.read(256 * 1024);
    if (!chunk || chunk.length === 0) return;
    yield Buffer.from(chunk);
  }
}

export function stopTransport(): void {
  endpoint = null;
}
