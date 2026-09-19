/** sync/album-index.ts — publishing a person's owned albums so a linked peer can match them. See docs/post-v1-reunification-design.md §4. */

import type { Creds } from '../immich/access.ts';
import { readCallerAlbums } from '../immich/access.ts';
import type { OwnedAlbum, Peer } from '../store.ts';
import { peerRequest } from '../p2p/transport.ts';
import { store } from '../state.ts';
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
  store.publishedAlbumsSet(peer, callerUserId, albums);
  return albums;
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
    const r = await peerRequest(peer, '/albums');
    if (r.status >= 400 || !Array.isArray(r.json?.albums)) return store.publishedAlbumsFor(peer.pub);
    // REPLACE the peer's whole index rather than one owner at a time. This answer IS the whole
    // index, so an owner missing from it has withdrawn everything and must stop being matched
    // against — which the per-owner write cannot express, because it is only ever called FOR an
    // owner the answer still mentions.
    store.publishedAlbumsReplacePeer(peer.pub, r.json.albums as OwnedAlbum[]);
    return store.publishedAlbumsFor(peer.pub);
  } catch {
    return store.publishedAlbumsFor(peer.pub); // unreachable right now: keep what we have
  }
}

/** What this server offers the given peer for matching. */
export const publishedAlbumsFor = (peer: string): OwnedAlbum[] => store.publishedAlbumsFor(peer);
