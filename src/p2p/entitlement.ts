/**
 * p2p/entitlement.ts — what a peer is allowed to READ, as distinct from who it is.
 *
 * The connection proves which peer is calling. It says nothing about which assets that peer
 * may see, and the byte routes serve from the local Immich with the admin key — so identity
 * alone would let any enrolled peer read anything in the library that it could name.
 * Entitlement is tracked positively, and the `offered` index is the SOLE authority: every
 * asset we advertise to a mapping (in a redeem response, a manifest, or a ref push) is
 * recorded BEFORE it is advertised, and the byte routes serve exactly that list. Removal is
 * real revocation: the watcher drops rows for assets that leave the album
 * (store.offeredReconcile), and mapping teardown drops the mapping's rows wholesale.
 *
 * There is deliberately no fallback that re-derives access from Immich on a miss — a second,
 * looser oracle would grant album-wholesale (including assets the manifest deliberately
 * excludes) and silently undo per-photo revocation on the next cache miss.
 */
import { state, store } from '../state.ts';

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

/** May this peer read this local asset's bytes? Exactly the offered index, nothing else. */
export function peerMayRead(peerPub: string, assetId: string): boolean {
  const mappings = mappingsFacing(peerPub);
  if (!mappings.length) return false;
  return store.offeredAllows(
    mappings.map(m => m.id),
    assetId
  );
}

/** Drop a mapping's entitlements — called wherever its ledger is dropped. */
export function forgetOffered(mappingId: string) {
  store.offeredRemoveMapping(mappingId);
}
