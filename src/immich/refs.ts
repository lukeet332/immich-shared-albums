/**
 * immich/refs.ts — the on-the-wire representation of a shared photo. Converts local
 * assets to AssetRefs, decides what an album may offer a peer (offer set vs push queue),
 * and builds the manifest a member diffs against.
 */
import type { AssetRef } from '../types.ts';
import { CFG, personName } from '../config.ts';
import { usersById } from './client.ts';
import { wireChecksum, ledgerByAsset, seenHas } from '../state.ts';

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
export async function offerableAssets(assets) {
  const users = await usersById();
  return assets.filter(
    a => (a.type === 'IMAGE' || a.type === 'VIDEO') && (!users[a.ownerId]?.utility || !!ledgerByAsset(a.id))
  );
}
// The push queue: offerable minus what this mapping has already sent.
export async function shareableAssets(assets, mappingId) {
  return (await offerableAssets(assets)).filter(a => !seenHas(mappingId, wireChecksum(a)));
}
// Everything shareable with the peer behind mappingId (see shareableAssets for the rules).
export async function buildManifest(assets) {
  const out: AssetRef[] = [];
  for (const a of await offerableAssets(assets)) out.push(await assetToRef(a));
  return out;
}
