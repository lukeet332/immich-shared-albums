/** sync/adoption.ts — deciding whether a populated album may be adopted as a share's local half. See docs/post-v1-reunification-design.md §2. */

import { normaliseAlbumName } from './matches.ts';

/** The local album an adoption would use. It carries the album's ID — which `OwnedAlbum` must not,
 *  since that type is the index published to a peer and an id there would be disclosure with no
 *  use. This is the same album, described for a local write. */
export type AdoptableAlbum = { albumId: string; name: string };

/** The share being pointed somewhere: the album name the peer offers, and who owns it there. */
export type OfferToAdopt = {
  albumName: string;
  /** The offering album's owner ON THEIR SERVER. Matching is owner-to-owner, so an album with the
   *  same name owned by nobody in particular is not the pair the panel showed. */
  peerOwnerUserId: string;
};

/**
 * The caller's own album that may be adopted for this offer, or undefined.
 *
 * An album id arriving from a panel is not evidence of anything, so this re-derives the match from
 * the caller's OWN album list: the album must be theirs (Immich says so inside `albumUsers`), and it
 * must carry the offered name by the same comparison the matcher uses. Anything else is refused, and
 * refusing means the share proceeds as an ordinary join rather than merging the wrong album.
 *
 * Name-only on purpose: Takeout exports no album-level metadata and Immich's album `createdAt` is
 * the import time, so no stricter signal exists (see the design doc §4). That is why reunification
 * is reversible from the panel.
 */
export function findAdoptableAlbum(
  offer: OfferToAdopt,
  callerAlbums: unknown,
  callerUserId: string
): AdoptableAlbum | undefined {
  const wanted = normaliseAlbumName(offer.albumName || '');
  if (!wanted) return undefined;
  // The raw album list carries the id, which the published index deliberately does not. Ownership
  // and the name are checked here rather than trusted from the request; `albumsIPublish` states the
  // same ownership rule, and this keeps the id alongside it rather than re-deriving the match.
  const albums = Array.isArray(callerAlbums) ? callerAlbums : [];
  const mine = albums.find(
    album => album?.id && normaliseAlbumName(album.albumName) === wanted && ownsIt(album, callerUserId)
  );
  return mine ? { albumId: mine.id, name: String(mine.albumName) } : undefined;
}

/** Immich decides ownership and says so inside `albumUsers`; an album with no owner entry is
 *  nobody's. Kept here rather than inlined so the refusal reads as the rule it is. */
const ownsIt = (album, userId: string) =>
  (Array.isArray(album?.albumUsers) ? album.albumUsers : []).some(
    au => au && au.role === 'owner' && au.user?.id === userId
  );

/**
 * The album a person's OWN album may replace an existing share's mirror with, or undefined.
 *
 * The panel's case, as distinct from acquiring a share for the first time: a share already exists
 * (an invitation created a mirror), and the person says "use my album instead". The mirror is ours
 * to replace; the album replacing it must be theirs, and must be the same album the share is about,
 * because that is the match they were shown.
 *
 * A mapping already pointing at that album is not an adoption: re-seeding a ledger from the same
 * contents would drop what it knows and learn it again, which is churn with no meaning.
 */
export function canUnifyOwnAlbum(
  mapping: { albumId: string; albumName: string },
  request: { albumName: string },
  callerAlbums: unknown,
  callerUserId: string
): AdoptableAlbum | undefined {
  // The share is about `mapping.albumName`; the request names the album to put in its place. They
  // must be the same album, or this would reunite a share with an unrelated one of the caller's.
  if (normaliseAlbumName(request.albumName || '') !== normaliseAlbumName(mapping.albumName)) return undefined;
  const found = findAdoptableAlbum(
    { albumName: mapping.albumName, peerOwnerUserId: callerUserId },
    callerAlbums,
    callerUserId
  );
  if (!found || found.albumId === mapping.albumId) return undefined; // already the mapping's album
  return found;
}
