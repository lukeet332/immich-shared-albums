/** sync/matches.ts — finding the other half of a split album. See docs/post-v1-reunification-design.md §4. */

/** One album a person owns, as it travels for matching. No album id: the peer cannot act on an
 *  album id it has no mapping for, so sending them would be disclosure without a use. */
export type OwnedAlbum = {
  name: string;
  assetCount: number;
  startDate?: string;
  endDate?: string;
  /** The person who owns the album HERE, on this server. Required: §4 routes the repair
   *  request owner-to-owner, and the match surfaces only in that owner's panel. */
  ownerUserId: string;
  ownerName: string;
};

export type AlbumCandidate = {
  mine: OwnedAlbum;
  theirs: OwnedAlbum;
  /** True when the two records overlap in time — an ordering signal, never a gate. */
  sameDates: boolean;
  why: string;
};

/** The album the given user owns, or undefined when they do not own it.
 *
 *  Immich decides this and says so inside `albumUsers` — an album response carries no `ownerId`.
 *  An album with no owner entry is nobody's: skipping it is what keeps a guess out of the index. */
function ownedAlbumFrom(album, userId: string): OwnedAlbum | undefined {
  const owner = (album?.albumUsers || []).find(au => au.role === 'owner' && au.user?.id);
  if (!owner || owner.user.id !== userId) return undefined;
  return {
    name: album.albumName,
    assetCount: Number(album.assetCount) || 0,
    startDate: album.startDate,
    endDate: album.endDate,
    ownerUserId: userId,
    ownerName: owner.user.name || '',
  };
}

/** What this server offers a linked peer for matching: ONLY albums the caller owns.
 *
 *  Owned-only is the minimal disclosure, and it cannot offer the same album twice when two local
 *  people are both members of it. It is also sufficient, because Takeout flattens ownership — the
 *  Google Photos importer creates an album per Google album through the importing account's key
 *  (`--sync-albums`), so an album that was someone else's on Google is owned here. */
export function albumsIPublish(albums, userId: string): OwnedAlbum[] {
  return albums.map((album: unknown) => ownedAlbumFrom(album, userId)).filter(Boolean) as OwnedAlbum[];
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
