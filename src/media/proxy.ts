/**
 * media/proxy.ts — the hotlink byte path. fetchTrueBytes resolves an asset's real pixels:
 * a local file for our own photos, or a chained fetch to the owner's server for a proxy
 * (how a relayed photo streams D <- origin <- contributor). Range passes through.
 */
import { log } from '../config.ts';
import { state, store } from '../state.ts';
import { sign, verify } from '../peers.ts';
import { immich } from '../immich/client.ts';

// Resolve true bytes for any local asset: local file for our own photos; for a proxy
// (ledger entry with `o`), chain the fetch to the owner's server — how a relayed
// photo's pixels stream D <- origin <- contributor. Range passes through for players.
export async function fetchTrueBytes(assetId: string, kind: 'preview' | 'original' | 'playback', range?: string) {
  const entry = store.ledgerWithOrigin(assetId);
  if (entry) {
    const mapping = state.mappings.find(mp => mp.id === entry.m);
    const peer = mapping && state.peers.find(p => p.pub === mapping.peer);
    if (peer) {
      const headers: Record<string, string> = { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(entry.o) };
      if (range) headers.Range = range;
      const up = await fetch(`${peer.url}/sidecar/api/v1/assets/${entry.o}/${kind}`, { headers });
      if (up.ok) return up;
      log(`chained ${kind} fetch failed (${up.status}) — serving local stub`);
    }
  }
  const local = kind === 'original' ? `/assets/${assetId}/original`
    : kind === 'playback' ? `/assets/${assetId}/video/playback`
    : `/assets/${assetId}/thumbnail?size=preview`;
  return immich(local, range ? { headers: { Range: range } } : {});
}
export async function handlePreview(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return fetchTrueBytes(assetId, 'preview'); // chains for relayed assets
}
export async function handleOriginal(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return fetchTrueBytes(assetId, 'original', req.headers.range);
}
export async function handlePlayback(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return fetchTrueBytes(assetId, 'playback', req.headers.range);
}
