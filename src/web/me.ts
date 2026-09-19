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
import { publishOwnedAlbums } from '../sync/album-index.ts';

export type MyAlbum = { name: string; role: Mapping['role']; via: Mapping['via']; peer: string };

/**
 * Offer the caller's OWN albums to one linked peer for matching.
 *
 * The albums come from Immich, read with the caller's own forwarded credential, never from the
 * request — so the set is exactly what Immich says the caller owns, and a client cannot widen or
 * narrow it. See sync/album-index.ts.
 */
export async function publishAlbumsForPeer(
  creds: Creds,
  callerUserId: string,
  peer: string
): Promise<number> {
  const albums = await publishOwnedAlbums(creds, callerUserId, peer);
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
