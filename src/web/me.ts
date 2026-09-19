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
import { offerAlbumsTo, publishOwnedAlbums, refreshPeerAlbums } from '../sync/album-index.ts';
import {
  albumsIPublish,
  matchesWithPeer,
  normaliseAlbumName,
  reunionStepFor,
  type PeerMatch,
  type ReunionStep,
} from '../sync/matches.ts';

export type MyAlbum = {
  name: string;
  role: Mapping['role'];
  via: Mapping['via'];
  peer: string;
  /** The mapping's id, so the panel can act on this album rather than name it. */
  mappingId: string;
  /** This album is part of a reunion, so the panel lists it with a way out of one. */
  reunified?: boolean;
};

/** Everything the panel needs to render itself, in the same call as its albums: who the household
 *  is (so the heading can name it, as the admin panel's does) and whether this caller may open the
 *  admin panel at all — a link a non-admin cannot follow is worse than no link. */
export type MePage = { albums: MyAlbum[]; household: string; isAdmin: boolean };

/**
 * A match as the panel needs it: the pairing, plus WHAT THIS PERSON CAN DO ABOUT IT.
 *
 * `step` is derived from the share behind the pairing, not from the pairing itself — see
 * `reunionStepFor`, which is where the rule lives and is unit-tested. A candidate with no share is
 * still worth showing (two people holding halves of the same Google album have no Immich share
 * between them at all), so the step is carried rather than the row being filtered out.
 *
 * `mappingId` comes with the `accept` step and only there: it is the local share to merge into, and
 * the other steps have nothing to act on.
 */
export type ActionableMatch = PeerMatch & { step: ReunionStep; mappingId?: string };

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
    out.push({
      name: m.albumName,
      role: m.role,
      via: m.via,
      peer,
      mappingId: m.id,
      ...(m.reunified ? { reunified: true } : {}),
    });
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
  // OFFER what this person owns, here and now, and offer even when the list is EMPTY. A panel visit
  // is the only moment the sidecar holds their credential, so it is the only moment an offer can be
  // made — and without one the peer has nothing to match against and "Possible album reunions" stays
  // empty for everyone. An offer of NOTHING is still an offer: it is how a peer learns that every
  // album this person had is gone, so this runs before the empty check, not inside the match loop.
  for (const peer of state.peers) offerAlbumsTo(mine, callerUserId, peer.pub);
  if (!mine.length) return [];
  const out: ActionableMatch[] = [];
  for (const peer of state.peers) {
    const theirs = await refreshPeerAlbums(peer);
    for (const candidate of matchesWithPeer(mine, theirs, peer)) {
      // The share this pairing is about, if one exists: the peer's mapping whose local album carries
      // that name. Names fold the way the matcher folds them, so a share named with different case or
      // spacing is still recognised as the share for the pairing it obviously is.
      const share = state.mappings.find(
        m =>
          !m.dead &&
          m.peer === peer.pub &&
          normaliseAlbumName(m.albumName) === normaliseAlbumName(candidate.mine.name)
      );
      const step = reunionStepFor(share);
      // A pairing that was already reunited is not a candidate: it belongs to the reunified albums,
      // with its way out. Leaving it here offered a reunion that had already happened, and the row
      // never went away — the one place a candidate must NOT be listed.
      if (step.kind === 'reunited') continue;
      out.push({ ...candidate, step, ...(step.kind === 'accept' ? { mappingId: step.mappingId } : {}) });
    }
  }
  return out;
}
