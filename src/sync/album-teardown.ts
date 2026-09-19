/** sync/album-teardown.ts — what leaving a share is allowed to remove. See sync-loops.md. */

/**
 * The fields the decision reads. `adopted` is a RECORDED fact — the mapping was pointed at an
 * album that already existed — not something inferred from the album's contents, because inferring
 * it would mean deciding whose photos these are at the moment of deletion.
 */
export type TeardownMapping = {
  role: 'owner' | 'member';
  /** Set when a mapping adopts an existing populated album instead of creating a mirror. */
  adopted?: boolean;
  albumName: string;
};

export type TeardownPlan = {
  /** May this sidecar DELETE the local album? The whole question this module answers. */
  deleteAlbum: boolean;
  /** Why, for the log — a teardown that quietly spares an album should say so. */
  reason: string;
};

/**
 * What leaving a share may touch.
 *
 * A mirror this sidecar created is ours: deleting it is what makes a join fully reversible. An
 * ADOPTED album is not — it existed before the share and holds a person's own photos, so leaving
 * must give up the mapping and nothing else. The stubs of the peer's photos are the peer's to
 * withdraw and are not this decision's concern.
 */
export function albumTeardown(mapping: TeardownMapping): TeardownPlan {
  if (mapping.adopted) return { deleteAlbum: false, reason: 'adopted album belongs to its owner' };
  return { deleteAlbum: true, reason: 'mirror created by this sidecar' };
}
