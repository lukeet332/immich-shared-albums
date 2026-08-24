/** media/proxy.ts — the hotlink byte path: true pixels resolved locally or chained to the owner over iroh. See hotlink-bytes.md. */
import { log } from '../config.ts';
import { state, store } from '../state.ts';
import { peerByPub } from '../peers.ts';
import { peerByteRequest, recvIterable } from '../p2p/transport.ts';
import { peerMayRead } from '../p2p/entitlement.ts';
import { immich } from '../immich/client.ts';

/** One shape for bytes from anywhere — an Immich fetch Response or a peer stream. */
export type ByteSource = {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
};

const BYTE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

export const fromFetchResponse = (r: Response): ByteSource => {
  const headers: Record<string, string> = {};
  for (const h of BYTE_HEADERS) {
    const v = r.headers.get(h);
    if (v) headers[h] = v;
  }
  return {
    status: r.status,
    headers,
    body: (async function* () {
      if (!r.body) return;
      for await (const chunk of r.body) yield Buffer.from(chunk);
    })(),
  };
};

// Resolve true bytes for any local asset: local file for our own photos; for a proxy
// (ledger entry with `o`), chain the request to the owner's server over iroh — how a
// relayed photo's pixels stream D <- origin <- contributor. Range rides the frame.
export async function fetchTrueBytes(
  assetId: string,
  kind: 'preview' | 'original' | 'playback',
  range?: string
): Promise<ByteSource> {
  const entry = store.ledgerWithOrigin(assetId);
  if (entry) {
    const mapping = state.mappings.find(mp => mp.id === entry.mapping);
    const peer = mapping && peerByPub(mapping.peer);
    if (peer) {
      try {
        const up = await peerByteRequest(peer, `/assets/${entry.originAsset}/${kind}`, range);
        if (up.status < 400) return { status: up.status, headers: up.headers, body: recvIterable(up.recv) };
        log(`chained ${kind} fetch failed (${up.status}) — serving local stub`);
      } catch (e) {
        log(`chained ${kind} fetch error (${e.message}) — serving local stub`);
      }
    }
  }
  const local =
    kind === 'original'
      ? `/assets/${assetId}/original`
      : kind === 'playback'
        ? `/assets/${assetId}/video/playback`
        : `/assets/${assetId}/thumbnail?size=preview`;
  return fromFetchResponse(await immich(local, range ? { headers: { Range: range } } : {}));
}

/** Enrolled AND on the list of things we offered them. Both, every time. */
export async function servePeerBytes(
  callerPub: string,
  assetId: string,
  kind: 'preview' | 'original' | 'playback',
  range?: string
): Promise<{ status: number; headers?: Record<string, string>; body?: Buffer | AsyncIterable<Buffer> }> {
  const peer = peerByPub(callerPub);
  if (!peer) return { status: 403, body: Buffer.from(JSON.stringify({ error: 'unknown peer' })) };
  if (!peerMayRead(callerPub, assetId)) {
    log(`byte read refused: "${peer.name}" is not entitled to asset ${assetId.slice(0, 8)}`);
    return { status: 403, body: Buffer.from(JSON.stringify({ error: 'not shared with you' })) };
  }
  const src = await fetchTrueBytes(assetId, kind, range);
  return { status: src.status, headers: src.headers, body: src.body };
}
