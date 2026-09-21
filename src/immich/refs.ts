/** immich/refs.ts — the on-the-wire representation of a shared photo: refs, the offer set, the push
 *  queue and the manifest. See local-immich-api.md. */
import type { AssetRef } from '../types.ts';
import { CFG, personName } from '../config.ts';
import { usersById } from './client.ts';
import { wireChecksum, ledgerByAsset, seenHas } from '../state.ts';
import { displayDims, shapeIsKnown } from './shape.ts';
import { isHiddenAsUnmeasured } from './unmeasured.ts';

/** What Immich knows about this photo, unless a rig is pretending its metadata job has not run. */
const measuredExif = a => (isHiddenAsUnmeasured(a.id) ? undefined : a.exifInfo);

// A shared photo, described for a peer. For utility-owned proxies (relayed photos)
// the true contributor is recovered from the utility user's name; the credit line we
// append locally is stripped so downstream hops don't stack "Shared by" twice.
export async function assetToRef(a): Promise<AssetRef> {
  const u = (await usersById())[a.ownerId];
  const displayName = u?.utility ? personName(u.name) : a.owner?.name || u?.name || CFG.name;
  const description = (a.exifInfo?.description || '').replace(/(?:\n\n)?Shared by [^\n]*$/, '') || undefined;
  return {
    originAsset: a.id,
    checksum: wireChecksum(a),
    kind: a.type === 'VIDEO' ? 'video' : 'image',
    takenAt: a.exifInfo?.dateTimeOriginal || a.fileCreatedAt,
    exif: a.exifInfo
      ? {
          latitude: a.exifInfo.latitude,
          longitude: a.exifInfo.longitude,
          description,
          rating: a.exifInfo.rating,
          ...displayDims(measuredExif(a)),
        }
      : undefined,
    contributor: { displayName, originUserId: a.ownerId },
  };
}

// What may be offered to the peer behind `mappingId`: photos/videos they haven't seen,
// excluding utility-owned proxies with no ledger entry (unknown provenance). Proxies with
// a ledger entry carry their SOURCE checksum on the wire, so the per-mapping seen-ledger
// guarantees a household never receives its own photo back — which is what enables
// relaying member contributions onward to other member households.
// The full offer set for an album: media we can vouch for (human-owned, or proxies
// with known provenance). This is what manifests advertise — members diff against it,
// so it must NOT exclude already-synced assets.
//
// A photo Immich has NOT measured yet is held back as well, from the push and from the manifest
// both. The shape of a mirror stub lives in the stub's own pixels, and no Immich API can change it
// afterwards, so one built before the metadata job runs would be square for the rest of its life.
// Nothing is recorded for what is held back, so the push queue (`shareableAssets`) offers it again
// on the next cycle — the retry IS the wait, and there is no second pass to run. `awaitingShape`
// is returned rather than inferred so the watcher can tell "nothing to push" from "not yet".
export async function offerableAssets(assets) {
  let users = await usersById();
  // An owner the cache has never heard of is NOT a human by default. The cache is refreshed on a
  // timer, so an account created since — a utility user provisioned seconds ago, a stub written by
  // a duplicate materialisation — has no entry, and treating "unknown" as "human" offered such a
  // stub to the origin as a fresh contribution: the origin materialised a stub of its own photo
  // and every household's count went up by one (issue #70). Refresh once for unknown owners; an
  // owner still unknown after that is left out of this cycle and reconsidered on the next.
  if (assets.some(a => a.ownerId && !users[a.ownerId])) users = await usersById(0);
  const shareable = assets.filter(a => {
    if (a.type !== 'IMAGE' && a.type !== 'VIDEO') return false;
    const owner = users[a.ownerId];
    if (!owner) return false;
    return !owner.utility || !!ledgerByAsset(a.id);
  });
  const offer = shareable.filter(a => shapeIsKnown(measuredExif(a)));
  return { offer, awaitingShape: shareable.length - offer.length };
}
// The push queue: offerable minus what this mapping has already sent, plus how many photos are
// waiting only on Immich to measure them.
export async function shareableAssets(assets, mappingId) {
  const { offer, awaitingShape } = await offerableAssets(assets);
  return { refs: offer.filter(a => !seenHas(mappingId, wireChecksum(a))), awaitingShape };
}
// Everything shareable with the peer behind mappingId (see shareableAssets for the rules).
export async function buildManifest(assets) {
  const out: AssetRef[] = [];
  const { offer } = await offerableAssets(assets);
  for (const a of offer) out.push(await assetToRef(a));
  return out;
}
