/** sync/album-index.ts — publishing a person's owned albums so a linked peer can match them. See docs/post-v1-reunification-design.md §4. */

import type { Creds } from '../immich/access.ts';
import { readCallerAlbums } from '../immich/access.ts';
import type { OwnedAlbum } from '../store.ts';
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

/** What this server offers the given peer for matching. */
export const publishedAlbumsFor = (peer: string): OwnedAlbum[] => store.publishedAlbumsFor(peer);
