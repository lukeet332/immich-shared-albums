/**
 * immich/refs.ts — the on-the-wire representation of a shared photo. Converts local
 * assets to AssetRefs, decides what an album may offer a peer (offer set vs push queue),
 * and builds the manifest a member diffs against.
 */
import type { AssetRef } from '../types.ts';
import { CFG, personName } from '../config.ts';
import { usersById } from './client.ts';
import { wireChecksum, ledgerByAsset, seenHas } from '../state.ts';

// Immich stores raw sensor dimensions plus an EXIF orientation; the DISPLAYED photo (and the
// oriented thumbnail the interceptor serves) has width/height swapped for the quarter-turn
// orientations (5–8). Send the DISPLAY dimensions so the mirror stub's aspect matches what Immich
// actually renders. Absent/unreadable exif -> no dimensions -> receiver keeps the legacy 1×1 stub.
function displayDims(exif): { width?: number; height?: number } {
  const w = Number(exif?.exifImageWidth);
  const h = Number(exif?.exifImageHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return {};
  const o = Number(exif?.orientation);
  return o >= 5 && o <= 8 ? { width: h, height: w } : { width: w, height: h };
}

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
          ...displayDims(a.exifInfo),
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
  let users = await usersById();
  // An owner the cache has never heard of is NOT a human by default. The cache is refreshed on a
  // timer, so an account created since — a utility user provisioned seconds ago, a stub written by
  // a duplicate materialisation — has no entry, and treating "unknown" as "human" offered such a
  // stub to the origin as a fresh contribution: the origin materialised a stub of its own photo
  // and every household's count went up by one (issue #70). Refresh once for unknown owners; an
  // owner still unknown after that is left out of this cycle and reconsidered on the next.
  if (assets.some(a => a.ownerId && !users[a.ownerId])) users = await usersById(0);
  return assets.filter(a => {
    if (a.type !== 'IMAGE' && a.type !== 'VIDEO') return false;
    const owner = users[a.ownerId];
    if (!owner) return false;
    return !owner.utility || !!ledgerByAsset(a.id);
  });
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
