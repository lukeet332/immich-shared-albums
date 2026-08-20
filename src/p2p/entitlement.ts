/**
 * p2p/entitlement.ts — what a peer is allowed to READ, as distinct from who it is.
 *
 * A signature proves which peer is calling. It says nothing about which assets that peer
 * may see, and the byte routes serve from the local Immich with the admin key — so
 * identity alone would let any enrolled peer read anything in the library that it could
 * name. Entitlement is tracked positively: every asset we advertise to a mapping (in a
 * redeem response, a manifest, or a ref push) is recorded, and the byte routes serve only
 * what is on that list.
 *
 * The list is a cache of a fact Immich already holds — "is this asset in an album mapped
 * to that peer" — so a miss falls back to asking Immich and backfilling. That keeps
 * installs upgraded from a version without this table working without a re-sync, and is
 * rate-limited per mapping so a caller guessing asset ids cannot turn each miss into an
 * album enumeration.
 */
import { log } from '../config.ts';
import { state, store } from '../state.ts';
import { getAlbumAssets } from '../immich/client.ts';

const BACKFILL_EVERY_MS = 10 * 60 * 1000;
const lastBackfill = new Map<string, number>();

/** Live mappings that face this peer, either role — a member relays its own
 *  contributions back to the origin, so member mappings grant reads too. */
const mappingsFacing = (peerPub: string) => state.mappings.filter(m => m.peer === peerPub && !m.dead);

/** Record assets we have advertised to a mapping's peer. Safe to call repeatedly. */
export function recordOffered(mappingId: string, assetIds: (string | undefined)[]) {
  const ids = assetIds.filter((a): a is string => !!a);
  if (ids.length) store.offeredAdd(mappingId, ids);
}

/** Record a manifest's worth of refs (each carries the ORIGIN asset id). */
export function recordOfferedRefs(mappingId: string, manifest: { originAsset?: string }[]) {
  recordOffered(
    mappingId,
    manifest.map(r => r.originAsset)
  );
}

/**
 * May this peer read this local asset's bytes? Checks the offered index first; on a miss,
 * re-derives entitlement from album membership (throttled) and backfills.
 */
export async function peerMayRead(peerPub: string, assetId: string): Promise<boolean> {
  const mappings = mappingsFacing(peerPub);
  if (!mappings.length) return false;
  const ids = mappings.map(m => m.id);
  if (store.offeredAllows(ids, assetId)) return true;

  // Miss. Either this predates the offered index, or the caller is guessing. Re-derive
  // from Immich at most once per mapping per window, then re-check.
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

/** Drop a mapping's entitlements — called wherever its ledger is dropped. */
export function forgetOffered(mappingId: string) {
  store.offeredRemoveMapping(mappingId);
  lastBackfill.delete(mappingId);
}
