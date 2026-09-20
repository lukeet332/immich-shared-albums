/** sync/album-index.ts — publishing a person's owned albums so a linked peer can match them. See docs/post-v1-reunification-design.md §4. */

import type { Creds } from '../immich/access.ts';
import { readCallerAlbums } from '../immich/access.ts';
import type { OwnedAlbum, Peer } from '../store.ts';
import { peerRequest, withDeadline } from '../p2p/transport.ts';
import { emitPanelEvent } from '../panel-events.ts';
import { indexChanged } from './index-offer.ts';

/** How long a panel visit waits for a peer's index before answering from the one it has.
 *
 *  Opening the panel is a person waiting, and a peer behind a relay that has to be re-dialled costs
 *  seconds — measured at the transport's own 10s dial deadline, every time. Matching is a pull, so
 *  an index a visit or two stale is the ordinary case; a blank section for ten seconds is not. */
export const INDEX_REFRESH_DEADLINE_MS = 2500;
import { state, store } from '../state.ts';
import { albumsIPublish } from './matches.ts';

/**
 * Read the caller's OWN albums from Immich and record them for one peer.
 *
 * The sidecar holds no credential for a human and `GET /albums` is scoped to one, so this runs on
 * the caller's forwarded credential — and that is the point: ownership is answered by the server
 * that owns the albums, so nothing a client posts can add an album the caller does not own or omit
 * one they do. That single call already carries the name, the dates, the count and the owner
 * inside `albumUsers`.
 */
export async function publishOwnedAlbums(creds: Creds, callerUserId: string, peer: string) {
  const albums = albumsIPublish(await readCallerAlbums(creds), callerUserId);
  offerAlbumsTo(albums, callerUserId, peer);
  return albums;
}

/** Record what this person offers a peer, from an album list already in hand.
 *
 *  Separate from `publishOwnedAlbums` because the panel ALREADY reads the caller's albums to compute
 *  their matches: offering them is the same fact, and re-reading Immich for it would be a second
 *  round trip for nothing. */
export function offerAlbumsTo(albums: OwnedAlbum[], callerUserId: string, peerPub: string) {
  store.publishedAlbumsSet(peerPub, 'to-them', callerUserId, albums);
}

/**
 * Refresh what a peer offers us, from the peer's own `/albums`.
 *
 * Pull-only, like invitations: a household behind CGNAT still matches perfectly well, and a peer
 * too old to know the route answers 404 — which is "peer too old", not an error (wire rule 2), so
 * the cached index simply stands. Best-effort: a failure leaves the last good snapshot in place
 * rather than clearing an index the panel is about to read.
 */
export async function refreshPeerAlbums(peer: Peer): Promise<OwnedAlbum[]> {
  try {
    const r = await withDeadline(
      peerRequest(peer, '/albums'),
      `album index from "${peer.name}"`,
      INDEX_REFRESH_DEADLINE_MS
    );
    if (r.status >= 400 || !Array.isArray(r.json?.albums))
      return store.publishedAlbumsFor(peer.pub, 'from-them');
    // REPLACE the peer's whole index rather than one owner at a time. This answer IS the whole
    // index, so an owner missing from it has withdrawn everything and must stop being matched
    // against — which the per-owner write cannot express, because it is only ever called FOR an
    // owner the answer still mentions.
    const before = store.publishedAlbumsFor(peer.pub, 'from-them');
    store.publishedAlbumsReplacePeer(peer.pub, 'from-them', r.json.albums as OwnedAlbum[]);
    const after = store.publishedAlbumsFor(peer.pub, 'from-them');
    // ONLY on a real change: a panel's own match read lands here, so an unconditional hint tells the
    // page that asked to ask again — forever, and never landing a fresh answer.
    if (indexChanged(before, after)) emitPanelEvent('index');
    return after;
  } catch {
    return store.publishedAlbumsFor(peer.pub, 'from-them'); // unreachable right now: keep what we have
  }
}

/**
 * Refresh what every linked peer offers us, bounded and best-effort.
 *
 * The index is a PULL like every other cross-server fact — manifests, invitations, comments — so it
 * belongs on the loop, not on a page. A panel that dials cannot be faster than the slowest peer it
 * is linked to (measured: 10.06s against 15ms for the same page's local read), and a person opening
 * their own albums has no business waiting on someone else's server.
 */
export async function refreshPeerIndexes(): Promise<number> {
  let refreshed = 0;
  for (const peer of state.peers) {
    const before = store.publishedAlbumsFor(peer.pub, 'from-them').length;
    const after = await refreshPeerAlbums(peer);
    if (after.length !== before || after.length) refreshed++;
  }
  return refreshed;
}

/** What this server OFFERS the given peer — the index its `/albums` route answers with. */
export const publishedAlbumsFor = (peer: string): OwnedAlbum[] => store.publishedAlbumsFor(peer, 'to-them');
