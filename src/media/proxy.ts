/**
 * media/proxy.ts — the hotlink byte path. fetchTrueBytes resolves an asset's real pixels:
 * a local file for our own photos, or a chained fetch to the owner's server for a proxy
 * (how a relayed photo streams D <- origin <- contributor). Range passes through.
 *
 * These are the only routes that hand out real pixels, and the local branch reads with the
 * admin key — so a signature is necessary but nowhere near sufficient. Every handler asks
 * p2p/entitlement whether this specific peer was ever offered this specific asset. Without
 * that, "a valid peer" would mean "any asset in the library that it can name".
 */
import { log, ROUTE_PREFIX } from '../config.ts';
import { state, store } from '../state.ts';
import { sign, callingPeer } from '../peers.ts';
import { peerMayRead } from '../p2p/entitlement.ts';
import { immich } from '../immich/client.ts';

/**
 * Time out the handshake, not the transfer. A hostile or crawling peer must not be able to
 * hold a connection open forever, but a legitimate 4K original may stream for minutes — so
 * the clock stops the moment response headers arrive.
 */
async function fetchWithHeaderTimeout(url: string, init: RequestInit, ms = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Resolve true bytes for any local asset: local file for our own photos; for a proxy
// (ledger entry with `o`), chain the fetch to the owner's server — how a relayed
// photo's pixels stream D <- origin <- contributor. Range passes through for players.
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
      const headers: Record<string, string> = { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(entry.o) };
      if (range) headers.Range = range;
      try {
        const up = await fetchWithHeaderTimeout(
          `${peer.url}${ROUTE_PREFIX}/api/v1/assets/${entry.o}/${kind}`,
          { headers }
        );
        if (up.ok) return up;
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
  return immich(local, range ? { headers: { Range: range } } : {});
}

/** Signed by the peer AND on the list of things we offered them. Both, every time. */
async function authorisePeerRead(req, assetId: string) {
  const peer = callingPeer(req, assetId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  if (!(await peerMayRead(peer.pub, assetId))) {
    log(`byte read refused: "${peer.name}" is not entitled to asset ${assetId.slice(0, 8)}`);
    return [403, { error: 'not shared with you' }];
  }
  return null;
}

export async function handlePreview(req, assetId) {
  return (await authorisePeerRead(req, assetId)) ?? fetchTrueBytes(assetId, 'preview'); // chains for relayed assets
}
export async function handleOriginal(req, assetId) {
  return (await authorisePeerRead(req, assetId)) ?? fetchTrueBytes(assetId, 'original', req.headers.range);
}
export async function handlePlayback(req, assetId) {
  return (await authorisePeerRead(req, assetId)) ?? fetchTrueBytes(assetId, 'playback', req.headers.range);
}
