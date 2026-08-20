/** sync/leave.ts — undoing a join. See sync-loops.md. */
import { log } from '../config.ts';
import { state, store, save } from '../state.ts';
import { immichJson } from '../immich/client.ts';
import { deleteProxyAsset } from '../immich/materialise.ts';
import { forgetOffered } from '../p2p/entitlement.ts';

export async function leaveAlbum(mappingId: string) {
  const mapping = state.mappings.find(mp => mp.id === mappingId);
  if (!mapping || mapping.role !== 'member')
    throw new Error('unknown mapping (only joined albums can be left)');
  let removed = 0;
  for (const entry of store.seenForMapping(mapping.id)) {
    if (entry.o && (await deleteProxyAsset(entry.l))) removed++;
  }
  const host = mapping.adminSlug ? state.contributors[mapping.adminSlug] : undefined;
  if (host?.key) {
    try {
      await immichJson(`/albums/${mapping.albumId}`, { method: 'DELETE' }, host.key);
    } catch (e) {
      log(`mirror album delete failed: ${e.message}`);
    }
  }
  store.seenRemoveMapping(mapping.id);
  forgetOffered(mapping.id);
  // Splice, NEVER reassign: concurrent loops hold the old array reference.
  const mappingIndex = state.mappings.findIndex(mp => mp.id === mapping.id);
  if (mappingIndex >= 0) state.mappings.splice(mappingIndex, 1);
  save();
  log(`left "${mapping.albumName}" — ${removed} stub(s) purged`);
  return { left: mapping.albumName, purged: removed };
}
