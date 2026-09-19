/**
 * web/me.ts — data for the per-user panel (/me), ALWAYS scoped to the calling user.
 *
 * The user panel is the keystone surface for the reunification/repair feature. Membership is
 * never decided here: Immich answers it. The caller's own credential lists the albums they can
 * see, and a mapping only appears if that list contains its local album — reading as the admin
 * and then filtering for the caller refuses the very mirrors this panel exists for.
 */
import { state } from '../state.ts';
import type { Mapping } from '../store.ts';
import type { Creds } from '../immich/access.ts';
import { visibleAlbumIds } from '../immich/access.ts';
import { parsePublishedAlbums, recordPublishedAlbums } from '../sync/album-index.ts';

export type MyAlbum = { name: string; role: Mapping['role']; via: Mapping['via']; peer: string };

/**
 * Record what the caller published for a linked peer, scoped to the caller.
 *
 * The body comes from the panel, which built it from the caller's own album list — so it is
 * filtered to albums the caller OWNS before anything is stored (`parsePublishedAlbums`), because
 * a body is not evidence of ownership. Nothing is written for a signed-out caller.
 */
export function publishAlbumsForPeer(peer: string, body: string, callerUserId: string): number {
  const albums = parsePublishedAlbums(body, callerUserId);
  recordPublishedAlbums(peer, callerUserId, albums);
  return albums.length;
}

/** The caller's shared albums: mappings whose local album the caller can see, as themselves.
 *  A mapping the caller cannot see is absent from the list Immich returns — never leaked. */
export async function myAlbums(creds: Creds): Promise<MyAlbum[]> {
  const mine = await visibleAlbumIds(creds);
  const out: MyAlbum[] = [];
  for (const m of state.mappings) {
    if (m.dead || !mine.has(m.albumId)) continue;
    const peer = state.peers.find(p => p.pub === m.peer)?.name || 'a linked server';
    out.push({ name: m.albumName, role: m.role, via: m.via, peer });
  }
  return out;
}
