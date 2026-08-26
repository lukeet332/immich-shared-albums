/**
 * sync/backfill.ts — when the admin turns on "store shared assets locally", upgrade the mirrors we
 * already hold as stubs into full local copies. Runs inside the reconcile pass (under its per-mapping
 * mutex), a bounded number per cycle so a big album drains over several ticks, and stops on its own
 * once no stub rows remain (a stored-full ledger row is skipped).
 */
import { log } from '../config.ts';
import { store, state, seenAdd } from '../state.ts';
import { ensureContributor } from '../immich/contributors.ts';
import { uploadAsset, addToAlbum, applyRefMetadata } from '../immich/client.ts';
import { fetchFullOriginal, deleteProxyAsset } from '../immich/materialise.ts';

const MAX_PER_CYCLE = 20;

/** Are there mirrored stubs not yet upgraded to full copies? Gates the reconcile manifest pull so the
 *  backfill still runs when the album's version hasn't changed. */
export const hasStubRows = (mappingId: string) =>
  store.seenForMapping(mappingId).some(r => r.originAsset && !r.storedFull);

export async function backfillFullCopies(mapping, peer, manifest): Promise<void> {
  const stubs = new Map(
    store
      .seenForMapping(mapping.id)
      .filter(r => r.originAsset && !r.storedFull)
      .map(r => [r.checksum, r])
  );
  if (!stubs.size) return;
  let done = 0;
  for (const ref of manifest) {
    if (done >= MAX_PER_CYCLE) break;
    const row = stubs.get(ref.checksum);
    if (!row) continue;
    try {
      if (await upgradeToFull(mapping, peer, ref, row)) {
        done++;
        log(`backfilled a full local copy into "${mapping.albumName}"`);
      }
    } catch (e) {
      log(`backfill failed (${ref.checksum?.slice(0, 10)}): ${e.message}`);
    }
  }
}

// Replace one stub with a full local copy: upload the full bytes FIRST (never a gap with no asset),
// swap the ledger to point at the full copy, then delete the old stub. A crash between the swap and
// the delete leaves a stray grey stub — harmless and rare — rather than losing the photo. A
// transient fetch failure ('retry') or an oversize original ('toobig') leaves the stub in place.
async function upgradeToFull(mapping, peer, ref, stubRow): Promise<boolean> {
  const full = await fetchFullOriginal(peer, ref, mapping.id);
  if (full === 'retry' || full === 'toobig') return false;
  const hostKey = mapping.hostSlug ? state.contributors[mapping.hostSlug]?.apiKey : undefined;
  const c = await ensureContributor(
    ref.contributor?.displayName || peer.name,
    mapping.albumId,
    hostKey,
    peer,
    ref.contributor?.originUserId,
    mapping.peer,
    { reAddIfMissing: true }
  );
  const slug = ref.checksum.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const up = await uploadAsset(full.bytes, `shared-${slug}.${full.ext}`, c.apiKey, ref.takenAt);
  await addToAlbum(mapping.albumId, [up.id], c.apiKey);
  await applyRefMetadata(up.id, ref, c.apiKey);
  store.seenRemoveEntry(mapping.id, ref.checksum);
  seenAdd(mapping.id, ref.checksum, up.id, ref.originAsset, true);
  await deleteProxyAsset(stubRow.localAsset);
  return true;
}
