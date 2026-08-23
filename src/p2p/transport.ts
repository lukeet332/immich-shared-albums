/** p2p/transport.ts — the iroh peer transport: endpoint lifecycle, dial-by-key, request framing. See wire-protocol.md. */
import crypto from 'node:crypto';
import { Endpoint, EndpointAddr, EndpointId, presetMinimal } from '@number0/iroh';
import { CFG, log } from '../config.ts';
import { keys, save } from '../state.ts';
import type { Peer } from '../store.ts';

export const PROTOCOL_ALPN = Array.from(Buffer.from('isa/2'));

// Our stored keys are DER (spki/pkcs8) base64url; iroh speaks raw 32-byte ed25519. The spki
// prefix is a constant, so the two are the same key in different envelopes.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const pubToRaw = (pubDerB64: string): number[] =>
  Array.from(Buffer.from(pubDerB64, 'base64url').subarray(SPKI_PREFIX.length));
export const rawToPub = (raw: number[] | Uint8Array): string =>
  Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]).toString('base64url');

const secretSeed = (): number[] => {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(keys.priv, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return Array.from(Buffer.from(jwk.d, 'base64url'));
};

// ---- framing: one bi-stream per request ----
// request  = u32-LE header length, JSON { path, range? }, u32-LE body length, body bytes
// response = u32-LE header length, JSON { status, headers? }, body bytes until FIN
type FrameHeader = { path: string; range?: string };
type ResponseHeader = { status: number; headers?: Record<string, string> };

const lenPrefixed = (payload: Buffer): number[] => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length);
  return Array.from(Buffer.concat([len, payload]));
};

const readPrefixed = async (recv: { readExact(size: number): Promise<number[]> }, limit: number): Promise<Buffer> => {
  const len = Buffer.from(await recv.readExact(4)).readUInt32LE();
  if (len > limit) throw new Error(`frame of ${len} bytes exceeds the ${limit}-byte limit`);
  return len === 0 ? Buffer.alloc(0) : Buffer.from(await recv.readExact(len));
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
  builder.alpns([PROTOCOL_ALPN]);
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

async function serveConnection(incoming: { accept(): Promise<{ connect(): Promise<any> }> }, handler: PeerHandler) {
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
  const header = JSON.parse((await readPrefixed(bi.recv, 64 * 1024)).toString()) as FrameHeader;
  const body = await readPrefixed(bi.recv, CFG.maxBodyKb * 1024);
  const res = await handler(callerPub, header.path, body, header.range);
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
  const conn = await connectionFor(peer);
  const bi = await conn.openBi();
  await bi.send.writeAll(lenPrefixed(Buffer.from(JSON.stringify(header))));
  await bi.send.writeAll(lenPrefixed(body));
  await bi.send.finish();
  return bi;
}

/** JSON request/response with a peer. Mirrors the old signedFetch/signedGet call sites. */
export async function peerRequest(
  peer: Peer,
  path: string,
  jsonBody?: unknown
): Promise<{ status: number; json: any }> {
  const bi = await roundTrip(peer, { path }, jsonBody === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(jsonBody)));
  const head = JSON.parse((await readPrefixed(bi.recv, 64 * 1024)).toString()) as ResponseHeader;
  const raw = Buffer.from(await bi.recv.readToEnd(64 * 1024 * 1024));
  return { status: head.status, json: raw.length ? JSON.parse(raw.toString()) : null };
}

/** Byte request with a peer — previews, originals, playback. Range rides the frame header. */
export async function peerByteRequest(
  peer: Peer,
  path: string,
  range?: string
): Promise<{ status: number; headers: Record<string, string>; recv: { read(size: number): Promise<number[]> } }> {
  const bi = await roundTrip(peer, { path, range }, Buffer.alloc(0));
  const head = JSON.parse((await readPrefixed(bi.recv, 64 * 1024)).toString()) as ResponseHeader;
  return { status: head.status, headers: head.headers ?? {}, recv: bi.recv };
}

export function stopTransport(): void {
  endpoint = null;
}
