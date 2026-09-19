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
import { readCallerAlbums, visibleAlbumIds } from '../immich/access.ts';
import { publishOwnedAlbums, refreshPeerAlbums } from '../sync/album-index.ts';
import { albumsIPublish, matchesWithPeer, type PeerMatch } from '../sync/matches.ts';

export type MyAlbum = { name: string; role: Mapping['role']; via: Mapping['via']; peer: string };

/** Everything the panel needs to render itself, in the same call as its albums: who the household
 *  is (so the heading can name it, as the admin panel's does) and whether this caller may open the
 *  admin panel at all — a link a non-admin cannot follow is worse than no link. */
export type MePage = { albums: MyAlbum[]; household: string; isAdmin: boolean };

/**
 * A match as the panel needs it: the pairing, plus the LOCAL id of the share to reunite, when there
 * is one. Both are optional, because a match does not require a share — two people holding halves of
 * the same Google album have no Immich share between them at all, and that is the pair this list
 * exists to show.
 *
 * `PeerMatch` carries neither on purpose: the matcher decides on names and owner, and an album id on
 * the wire would be disclosure with no use. The id here comes from a mapping the caller is part of.
 */
export type ActionableMatch = PeerMatch & { mappingId?: string };

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

/**
 * Albums the caller could reunite with a linked server's.
 *
 * The caller's own albums are read from Immich on their forwarded credential — the same call the
 * publish path makes, for the same reason — and each linked peer's index is refreshed first, so a
 * peer that has published since the last visit is seen now. Panels are visited rarely, so this
 * spends one request per peer when it is opened rather than on every sync tick.
 */
export async function myMatches(creds: Creds, callerUserId: string): Promise<ActionableMatch[]> {
  const mine = albumsIPublish(await readCallerAlbums(creds), callerUserId);
  if (!mine.length) return [];
  const out: ActionableMatch[] = [];
  for (const peer of state.peers) {
    const theirs = await refreshPeerAlbums(peer);
    for (const candidate of matchesWithPeer(mine, theirs, peer)) {
      // The share this pairing is about, if one exists yet: this peer's mapping on an album of that
      // name. Absent is the ordinary case for two halves that have never been shared — the match is
      // still worth showing, and the panel simply offers no action without a share to act on.
      const mapping = state.mappings.find(
        m => !m.dead && m.peer === peer.pub && m.albumName === candidate.mine.name
      );
      out.push({ ...candidate, ...(mapping ? { mappingId: mapping.id } : {}) });
    }
  }
  return out;
}
