/** immich/refs.ts — the on-the-wire representation of a shared photo. Converts local. See local-immich-api.md. */
import type { AssetRef } from '../types.ts';
import { CFG, personName } from '../config.ts';
import { usersById } from './client.ts';
import { wireChecksum, ledgerByAsset, seenHas } from '../state.ts';

export async function assetToRef(a): Promise<AssetRef> {
  const owner = (await usersById())[a.ownerId];
  const displayName = owner?.utility ? personName(owner.name) : a.owner?.name || owner?.name || CFG.name;
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

export async function everythingOfferable(assets) {
  const users = await usersById();
  return assets.filter(
    a => (a.type === 'IMAGE' || a.type === 'VIDEO') && (!users[a.ownerId]?.utility || !!ledgerByAsset(a.id))
  );
}
export async function notYetSentTo(assets, mappingId) {
  return (await everythingOfferable(assets)).filter(a => !seenHas(mappingId, wireChecksum(a)));
}
export async function buildManifest(assets) {
  const manifest: AssetRef[] = [];
  for (const asset of await everythingOfferable(assets)) manifest.push(await assetToRef(asset));
  return manifest;
}
