/** p2p/entitlement.ts — what a peer is allowed to READ, as distinct from who it is. See wire-protocol.md. */
import { log } from '../config.ts';
import { state, store } from '../state.ts';
import { getAlbumAssets } from '../immich/client.ts';

const BACKFILL_EVERY_MS = 10 * 60 * 1000;
const lastBackfill = new Map<string, number>();

const mappingsFacing = (peerPub: string) => state.mappings.filter(m => m.peer === peerPub && !m.dead);

export function recordOffered(mappingId: string, assetIds: (string | undefined)[]) {
  const ids = assetIds.filter((a): a is string => !!a);
  if (ids.length) store.offeredAdd(mappingId, ids);
}

export function recordOfferedRefs(mappingId: string, manifest: { originAsset?: string }[]) {
  recordOffered(
    mappingId,
    manifest.map(r => r.originAsset)
  );
}

export async function peerMayRead(peerPub: string, assetId: string): Promise<boolean> {
  const mappings = mappingsFacing(peerPub);
  if (!mappings.length) return false;
  const ids = mappings.map(m => m.id);
  if (store.offeredAllows(ids, assetId)) return true;

  const now = Date.now();
  let refreshed = false;
  for (const m of mappings) {
    if (now - (lastBackfill.get(m.id) ?? 0) < BACKFILL_EVERY_MS) continue;
    lastBackfill.set(m.id, now);
    try {
      const assets = await getAlbumAssets(m.albumId);
      recordOffered(
        m.id,
        assets.map((a: { id: string }) => a.id)
      );
      refreshed = true;
    } catch (e) {
      log(`entitlement backfill failed for "${m.albumName}": ${e.message}`);
    }
  }
  return refreshed ? store.offeredAllows(ids, assetId) : false;
}

export function forgetOffered(mappingId: string) {
  store.offeredRemoveMapping(mappingId);
  lastBackfill.delete(mappingId);
}
