/** media/proxy.ts — the hotlink byte path. fetchTrueBytes resolves an asset's real pixels: See hotlink-bytes.md. */
import { log, ROUTE_PREFIX } from '../config.ts';
import { state, store, keys } from '../state.ts';
import { sign, callingPeer } from '../peers.ts';
import { peerMayRead } from '../p2p/entitlement.ts';
import { immich } from '../immich/client.ts';

async function fetchWithHeaderTimeout(url: string, init: RequestInit, ms = 30000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTrueBytes(
  assetId: string,
  kind: 'preview' | 'original' | 'playback',
  range?: string
) {
  const entry = store.ledgerWithOrigin(assetId);
  if (entry) {
    const mapping = state.mappings.find(mp => mp.id === entry.m);
    const peer = mapping && state.peers.find(p => p.pub === mapping.peer);
    if (peer) {
      const headers: Record<string, string> = { 'x-isa-key': keys.pub, 'x-isa-sig': sign(entry.o) };
      if (range) headers.Range = range;
      try {
        const ownerResponse = await fetchWithHeaderTimeout(
          `${peer.url}${ROUTE_PREFIX}/api/v1/assets/${entry.o}/${kind}`,
          { headers }
        );
        if (ownerResponse.ok) return ownerResponse;
        log(`chained ${kind} fetch failed (${ownerResponse.status}) — serving local stub`);
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
  return immich(local, range ? { headers: { Range: range } } : {});
}

async function assertSignedAndEntitled(req, assetId: string) {
  const peer = callingPeer(req, assetId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  if (!(await peerMayRead(peer.pub, assetId))) {
    log(`byte read refused: "${peer.name}" is not entitled to asset ${assetId.slice(0, 8)}`);
    return [403, { error: 'not shared with you' }];
  }
  return null;
}

export async function handlePreview(req, assetId) {
  return (await assertSignedAndEntitled(req, assetId)) ?? fetchTrueBytes(assetId, 'preview'); // chains for relayed assets
}
export async function handleOriginal(req, assetId) {
  return (
    (await assertSignedAndEntitled(req, assetId)) ?? fetchTrueBytes(assetId, 'original', req.headers.range)
  );
}
export async function handlePlayback(req, assetId) {
  return (
    (await assertSignedAndEntitled(req, assetId)) ?? fetchTrueBytes(assetId, 'playback', req.headers.range)
  );
}
