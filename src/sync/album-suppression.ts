/** sync/album-suppression.ts — refusing to materialise a photo the album already holds. See sync-loops.md. */

/** The parts of a mapping this decision needs. */
export type AlbumMapping = { id: string; albumId: string; dead?: boolean };

/** A materialised row in the ledger, as the store returns it. */
export type LedgerRow = {
  mapping: string;
  checksum: string;
  localAsset: string;
  originAsset?: string | null;
  storedFull?: number;
};

/**
 * The mappings whose local half IS this album — the set a duplicate could arrive through.
 *
 * A dead mapping is excluded. Its ledger rows outlive it, and honouring one would suppress a photo
 * on the word of a share nothing is serving any more: the album would be left without it.
 */
export const mappingsSharingAlbum = (albumId: string, mappings: AlbumMapping[]): string[] =>
  mappings.filter(m => m.albumId === albumId && !m.dead).map(m => m.id);

/**
 * The row saying this album already holds this photo, materialised through some mapping.
 *
 * A 3-way mesh offers one photo through two shares that can land on the same album, and each would
 * otherwise materialise its own stub: the bytes differ by a random tail, so Immich cannot collapse
 * the second into the first and the album would show the photo twice. Scoped to the album on
 * purpose — the same photo in two different albums is the ordinary case, not a duplicate.
 */
export function existingCopyInAlbum(
  albumId: string,
  checksum: string,
  mappings: AlbumMapping[],
  rows: LedgerRow[]
): LedgerRow | undefined {
  const sharing = new Set(mappingsSharingAlbum(albumId, mappings));
  return rows.find(r => r.checksum === checksum && sharing.has(r.mapping));
}
