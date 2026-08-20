/**
 * sync/leave.ts — undoing a join.
 *
 * Its own module because three different things now trigger it: the stock app's "Leave album"
 * (detected by the watcher), the panel's leave button, and an invitation being withdrawn
 * upstream. Keeping it here also breaks what would otherwise be a load-time import cycle
 * between engine.ts and invites.ts, which ARCHITECTURE.md's third convention forbids.
 */
import { log } from '../config.ts';
import { state, store, save } from '../state.ts';
import { immichJson } from '../immich/client.ts';
import { deleteProxyAsset } from '../immich/materialise.ts';
import { forgetOffered } from '../p2p/entitlement.ts';

// Leave & purge: the reverse of joining. Removes every stub this album materialised
// (utility-owner-guarded), the mirror album, the mapping and its ledger — a join is
// fully reversible and reclaims all space it ever took.
export async function leaveAlbum(mappingId: string) {
  const mapping = state.mappings.find(mp => mp.id === mappingId);
  if (!mapping || mapping.role !== 'member') throw new Error('unknown mapping (only joined albums can be left)');
  let removed = 0;
  for (const entry of store.seenForMapping(mapping.id)) {
    if (entry.o && await deleteProxyAsset(entry.l)) removed++;
  }
  const host = mapping.adminSlug ? state.contributors[mapping.adminSlug] : undefined;
  if (host?.key) {
    try { await immichJson(`/albums/${mapping.albumId}`, { method: 'DELETE' }, host.key); }
    catch (e) { log(`mirror album delete failed: ${e.message}`); }
  }
  store.seenRemoveMapping(mapping.id);
  forgetOffered(mapping.id);
  // Splice, never reassign. Loops run concurrently (watch, comments, invites), and replacing
  // the array silently discards anything another loop pushed onto the old reference in the
  // meantime — which lost freshly-created mirrors until this was found.
  const at = state.mappings.findIndex(mp => mp.id === mapping.id);
  if (at >= 0) state.mappings.splice(at, 1);
  save();
  log(`left "${mapping.albumName}" — ${removed} stub(s) purged`);
  return { left: mapping.albumName, purged: removed };
}
