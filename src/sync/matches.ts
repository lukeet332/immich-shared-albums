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

/** One row of the ledger a mapping keeps, as adoption seeds it. */
export type SeedRow = { checksum: string; localAsset: string; originAsset?: string };

/** The share a pairing is about, as the panel has it: enough to say what a person may do next. */
export type ShareForReunion = {
  id: string;
  role: 'owner' | 'member';
  adopted?: boolean;
  reunified?: boolean;
  dead?: boolean;
};

/** What a person can do about one candidate.
 *
 *  Four cases rather than two, because a share has a DIRECTION and only the one they RECEIVED is
 *  theirs to accept: `accept` is the mirror they were given, `waiting` is the one they gave away —
 *  where adopting their own album is not an adoption at all, since `canUnifyOwnAlbum` refuses a
 *  share that already points at the album asked for. `reunited` is not a button at all: that pairing
 *  belongs to the reunified list, and leaving it here offered a reunion that had already happened. */
export type ReunionStep =
  { kind: 'invite' } | { kind: 'accept'; mappingId: string } | { kind: 'waiting' } | { kind: 'reunited' };

export function reunionStepFor(share: ShareForReunion | undefined): ReunionStep {
  if (!share || share.dead) return { kind: 'invite' }; // an ended share is no share: invite again
  if (share.reunified || share.adopted) return { kind: 'reunited' };
  return share.role === 'member' ? { kind: 'accept', mappingId: share.id } : { kind: 'waiting' };
}

/**
 * The ledger rows an ADOPTED mapping must start with, from the album it is adopting.
 *
 * Adopting a populated album means the mapping's ledger begins knowing nothing about the assets
 * already in it — while the ledger is the only thing stopping `shareableAssets` from offering them
 * back to the peer. Written before the mapping becomes visible to the loops, or the first watcher
 * cycle advertises the whole album to the household it came from.
 *
 * `originAsset` is deliberately left unset: these are this household's own photos, and
 * deletion propagation skips entries without an origin asset, so a peer withdrawing its copy can
 * never remove them. Two assets sharing a checksum collapse to one row, because the ledger is
 * unique on (mapping, checksum) and a duplicate would abort the seed half-written.
 */
export function seedRowsFor(assets: { id?: string; checksum?: string }[], _mappingId: string): SeedRow[] {
  const rows = new Map<string, SeedRow>();
  for (const asset of assets) {
    const checksum = asset?.checksum;
    if (!checksum || !asset?.id) continue; // nothing to key on: skip rather than guess
    if (!rows.has(checksum)) rows.set(checksum, { checksum, localAsset: asset.id });
  }
  return [...rows.values()];
}

/**
 * The rows an adoption must seed: the photos the peer ALREADY holds, and only those.
 *
 * Seeding a row means "the peer has this, do not offer it". Reunification exists to give each side
 * the union (design doc §2), so the photos only THIS side holds must stay unseeded — offering them
 * is the merge. The photos the peer already holds must be seeded, because the receiving side can
 * only suppress a duplicate it can see in its own ledger (`existingCopyInAlbum`): a peer's own
 * human-owned photo leaves no ledger row, so an offer of it lands as a stub beside the original.
 *
 * `peerHolds === undefined` means the peer could not be asked, and then EVERY row is seeded — the
 * merge is lost in one direction, which a later re-reunite repairs, rather than risking duplicates
 * in someone's album, which nothing repairs on its own.
 */
export function seedRowsForAdoption(
  assets: { id?: string; checksum?: string }[],
  peerHolds: Set<string> | undefined
): SeedRow[] {
  const rows = seedRowsFor(assets, '');
  return peerHolds ? rows.filter(r => peerHolds.has(r.checksum)) : rows;
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

/** The facts one row is made of: what a person reads, and what the server acts on. Two candidates
 *  that agree on all of them are the same row — the panel would print them identically — and the
 *  same action, because both are resolved by NAME: `canUnifyOwnAlbum` picks the album, the mapping
 *  picks the share. Nothing is hidden by keeping one, and the list stays readable. */
const asOneRow = (c: AlbumCandidate): string =>
  JSON.stringify(
    [c.mine, c.theirs].map(a => [
      a.name,
      a.ownerUserId,
      a.ownerName,
      a.assetCount,
      a.startDate ?? '',
      a.endDate ?? '',
    ])
  );

/** Same-named albums owned by different people on the two servers — the candidate halves.
 *
 *  The name is the only requirement. Date overlap and photo count are ORDERING signals, never a
 *  filter: §3 makes a miss cost a redundant stub and a false positive hide one photo reversibly,
 *  and §6 puts a human in front of every candidate, so a wide list is cheaper than a missed pair.
 *  A name held twice, with nothing to tell the two apart, is one row rather than two. */
export function matchAlbums(mine: OwnedAlbum[], theirs: OwnedAlbum[]): AlbumCandidate[] {
  const byName = new Map<string, OwnedAlbum[]>();
  for (const album of theirs) {
    const key = normaliseAlbumName(album.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(album);
    else byName.set(key, [album]);
  }
  const candidates: AlbumCandidate[] = [];
  const shown = new Set<string>();
  for (const album of mine) {
    for (const peerAlbum of byName.get(normaliseAlbumName(album.name)) || []) {
      // A shared album restored on both servers is owned by a different person on each — the same
      // owner on both sides is the same library, not two halves.
      if (peerAlbum.ownerUserId === album.ownerUserId) continue;
      const sameDates = datesOverlap(album, peerAlbum);
      const candidate = {
        mine: album,
        theirs: peerAlbum,
        sameDates,
        why: sameDates ? 'same album name, overlapping dates' : 'same album name',
      };
      const row = asOneRow(candidate);
      if (shown.has(row)) continue;
      shown.add(row);
      candidates.push(candidate);
    }
  }
  return candidates.sort(
    (x, y) => Number(y.sameDates) - Number(x.sameDates) || y.theirs.assetCount - x.theirs.assetCount
  );
}
