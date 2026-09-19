/** sync/matches.ts — finding the other half of a split album. See docs/post-v1-reunification-design.md §4. */

import type { OwnedAlbum } from '../store.ts';

export type { OwnedAlbum };

export type AlbumCandidate = {
  mine: OwnedAlbum;
  theirs: OwnedAlbum;
  /** True when the two records overlap in time — an ordering signal, never a gate. */
  sameDates: boolean;
  why: string;
};

/** The peer a publish is addressed to, or null when the body does not name one. The ONLY thing a
 *  publish body is read for: the albums come from Immich, never from the request. */
export function parseRequestedPeer(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || 'null');
  } catch {
    return null; // not JSON at all: nothing to address
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const peer = (parsed as { peer?: unknown }).peer;
  return typeof peer === 'string' && peer ? peer : null;
}

/** The album the given user owns, or undefined when they do not own it.
 *
 *  Immich decides this and says so inside `albumUsers` — an album response carries no `ownerId`.
 *  An album with no owner entry is nobody's: skipping it is what keeps a guess out of the index. */
function ownedAlbumFrom(album, userId: string): OwnedAlbum | undefined {
  // A malformed album (albumUsers as an object, a null member) is skipped, not thrown over: this
  // runs against what a peer or a peer's client produced, and the sidecar fails open.
  const members = Array.isArray(album?.albumUsers) ? album.albumUsers : [];
  const owner = members.find(au => au && au.role === 'owner' && au.user?.id);
  if (!owner || owner.user.id !== userId) return undefined;
  return {
    name: String(album.albumName ?? ''),
    assetCount: Number.isFinite(Number(album.assetCount)) ? Number(album.assetCount) : 0,
    startDate: album.startDate || undefined,
    endDate: album.endDate || undefined,
    ownerUserId: userId,
    ownerName: String(owner.user.name ?? ''),
  };
}

/** Immich's own album list as an owned index: the shape the panel has in hand, converted once.
 *  Unknown entries are dropped rather than guessed at, because a guess here offers someone's
 *  library to a linked server. */
export function albumsIPublish(albums, userId: string): OwnedAlbum[] {
  if (!userId || !Array.isArray(albums)) return [];
  return albums.map((album: unknown) => ownedAlbumFrom(album, userId)).filter(Boolean) as OwnedAlbum[];
}

/** One candidate as a person's panel sees it: my album, theirs, and whose server theirs is on.
 *  Built from `matchAlbums` — the pairing rule lives in one place, and this only names the peer. */
export type PeerMatch = AlbumCandidate & { peer: string; peerName: string };

/** Candidates on one peer, by that peer's name as this household knows it. */
export function matchesWithPeer(
  mine: OwnedAlbum[],
  theirs: OwnedAlbum[],
  peer: { pub: string; name: string }
): PeerMatch[] {
  return matchAlbums(mine, theirs).map(candidate => ({
    ...candidate,
    peer: peer.pub,
    peerName: peer.name,
  }));
}

/** Lowercase and collapse whitespace — recall, not privacy (§3). Everything else is significant:
 *  two albums differing in punctuation or digits are different albums, and treating them as one is
 *  how "Photos" swallows "Photos 2024". */
export const normaliseAlbumName = (name: string): string =>
  String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** Two records describe the same span of time. Missing dates answer false, so they sort last
 *  rather than matching on nothing. */
function datesOverlap(mine: OwnedAlbum, theirs: OwnedAlbum): boolean {
  const mineFrom = mine.startDate ?? '';
  const mineTo = mine.endDate ?? mine.startDate ?? '';
  const theirsFrom = theirs.startDate ?? '';
  const theirsTo = theirs.endDate ?? theirs.startDate ?? '';
  if (!mineFrom || !theirsFrom) return false;
  return mineFrom <= theirsTo && theirsFrom <= mineTo;
}

/** Same-named albums owned by different people on the two servers — the candidate halves.
 *
 *  The name is the only requirement. Date overlap and photo count are ORDERING signals, never a
 *  filter: §3 makes a miss cost a redundant stub and a false positive hide one photo reversibly,
 *  and §6 puts a human in front of every candidate, so a wide list is cheaper than a missed pair. */
export function matchAlbums(mine: OwnedAlbum[], theirs: OwnedAlbum[]): AlbumCandidate[] {
  const byName = new Map<string, OwnedAlbum[]>();
  for (const album of theirs) {
    const key = normaliseAlbumName(album.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(album);
    else byName.set(key, [album]);
  }
  const candidates: AlbumCandidate[] = [];
  for (const album of mine) {
    for (const peerAlbum of byName.get(normaliseAlbumName(album.name)) || []) {
      // A shared album restored on both servers is owned by a different person on each — the same
      // owner on both sides is the same library, not two halves.
      if (peerAlbum.ownerUserId === album.ownerUserId) continue;
      const sameDates = datesOverlap(album, peerAlbum);
      candidates.push({
        mine: album,
        theirs: peerAlbum,
        sameDates,
        why: sameDates ? 'same album name, overlapping dates' : 'same album name',
      });
    }
  }
  return candidates.sort(
    (x, y) => Number(y.sameDates) - Number(x.sameDates) || y.theirs.assetCount - x.theirs.assetCount
  );
}
