/** p2p/transport.ts — the iroh peer transport: endpoint lifecycle, dial-by-key, request framing. See wire-protocol.md. */
import { Endpoint, EndpointAddr, EndpointId, RelayMode, presetMinimal } from '@number0/iroh';
import { CFG, log } from '../config.ts';
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
const withDeadline = <T>(p: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} timed out after ${DEADLINE_MS / 1000}s`)),
        DEADLINE_MS
      );
    }),
  ]);
};

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

const connections = new Map<string, Promise<any>>();

async function dial(peer: Peer): Promise<any> {
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

async function connectionFor(peer: Peer): Promise<any> {
  const cached = connections.get(peer.pub);
  if (cached) {
    try {
      const conn = await cached;
      if (conn.closeReason() === null) return conn;
    } catch {
      /* fall through to redial */
    }
  }
  const fresh = dial(peer);
  connections.set(peer.pub, fresh);
  fresh.catch(() => connections.delete(peer.pub));
  return fresh;
}

async function roundTrip(peer: Peer, header: FrameHeader, body: Buffer) {
  if (!endpoint) throw new Error('transport not started');
  try {
    const conn = await withDeadline(connectionFor(peer), `dial to "${peer.name}"`);
    const bi = await conn.openBi();
    await bi.send.writeAll(lenPrefixed(Buffer.from(JSON.stringify(header))));
    await bi.send.writeAll(lenPrefixed(body));
    await bi.send.finish();
    return bi;
  } catch (e) {
    connections.delete(peer.pub); // a timed-out or broken connection must not be reused
    throw e;
  }
}

/** JSON request/response with a peer. Mirrors the old signedFetch/signedGet call sites. */
export async function peerRequest(
  peer: Peer,
  path: string,
  jsonBody?: unknown
): Promise<{ status: number; json: any }> {
  const bi = await roundTrip(
    peer,
    { path },
    jsonBody === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(jsonBody))
  );
  const head = JSON.parse(
    (await withDeadline(readPrefixed(bi.recv, 64 * 1024), `response from "${peer.name}"`)).toString()
  ) as ResponseHeader;
  const raw = Buffer.from(
    await withDeadline(bi.recv.readToEnd(64 * 1024 * 1024), `response body from "${peer.name}"`)
  );
  return { status: head.status, json: raw.length ? JSON.parse(raw.toString()) : null };
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
  const bi = await roundTrip(peer, { path, range, mapping }, Buffer.alloc(0));
  // Deadline covers the header only: byte BODIES may stream for as long as a video runs.
  const head = JSON.parse(
    (await withDeadline(readPrefixed(bi.recv, 64 * 1024), `byte response from "${peer.name}"`)).toString()
  ) as ResponseHeader;
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
