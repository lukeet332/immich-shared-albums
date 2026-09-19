/**
 * sync/album-index.ts — publishing a person's owned albums so a linked peer can match them.
 * See docs/post-v1-reunification-design.md §4.
 *
 * The sidecar holds no credential for a human, and `GET /albums` is scoped to one, so the
 * person's own session is the only thing that can enumerate their albums: the panel reads them
 * and hands them here. That makes the request body a trust boundary, which is why parsing and
 * ownership filtering happen together.
 */
import type { OwnedAlbum } from '../store.ts';
import { store } from '../state.ts';
import { albumsIPublish, albumsOwnedByCaller } from './matches.ts';

/** Bound on one publish body. A person's own takeout albums are numbered in the tens; this only
 *  exists so a hand-written body cannot fill the index. */
export const PUBLISHED_ALBUMS_MAX = 500;

/** Parse a panel's publish body. Unknown fields are ignored, unusable entries are dropped, and an
 *  entry claiming an owner other than the caller is refused — the browser is not a source of truth
 *  about who owns what. A body that is not a list of albums parses to an empty index rather than
 *  throwing, because the caller's next publish repairs it. */
export function parsePublishedAlbums(body: string, callerUserId: string): OwnedAlbum[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || 'null');
  } catch {
    return []; // not JSON at all: nothing to record
  }
  const albums = (parsed as { albums?: unknown })?.albums;
  if (!Array.isArray(albums)) return [];
  const usable = albums.slice(0, PUBLISHED_ALBUMS_MAX).filter(album => album && typeof album === 'object');
  // Converted HERE, from the Immich album shape the panel actually holds: the owner is inside
  // albumUsers, so anything that only reads a top-level ownerUserId would record nothing.
  return albumsOwnedByCaller(albumsIPublish(usable, callerUserId), callerUserId);
}

/** Record what one person published for one peer. Written per owner, so republishing one person's
 *  list never clears another's. */
export function recordPublishedAlbums(peer: string, ownerUserId: string, albums: OwnedAlbum[]) {
  store.publishedAlbumsSet(peer, ownerUserId, albums);
}

/** What this server offers the given peer for matching. */
export const publishedAlbumsFor = (peer: string): OwnedAlbum[] => store.publishedAlbumsFor(peer);
