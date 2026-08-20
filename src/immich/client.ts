/** immich/client.ts — the local Immich REST client. Every read/write against this. See local-immich-api.md. */
import crypto from 'node:crypto';
import { CFG, log, isUtilityEmail } from '../config.ts';
import type { AssetRef } from '../types.ts';

export const immich = async (path: string, init: RequestInit = {}, key: string = CFG.apiKey) => {
  const response = await fetch(`${CFG.immichUrl}/api${path}`, {
    signal: AbortSignal.timeout(60000),
    ...init,
    headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) },
  });
  if (!response.ok)
    throw new Error(`immich ${path} -> ${response.status} ${await response.text().catch(() => '')}`);
  return response;
};
export const immichJson = async (path: string, init?: RequestInit, key?: string) => {
  const response = await immich(path, init, key);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};
export const jsonBody = obj => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

export const UTILITY_SUFFIX = ' (via shared albums)';
export let USERS = {};
let USERS_AT = 0;
export async function usersById(maxAgeMs = 60000) {
  if (Date.now() - USERS_AT > maxAgeMs) {
    try {
      USERS = Object.fromEntries(
        (await immichJson('/admin/users')).map(u => [
          u.id,
          { name: u.name, utility: isUtilityEmail(u.email) },
        ])
      );
      USERS_AT = Date.now();
    } catch {
      /* keep stale map */
    }
  }
  return USERS;
}
export async function ownerName(ownerId) {
  const owner = (await usersById())[ownerId];
  return owner && !owner.utility ? owner.name : null;
}
export const getSharedLinkByKey = async key => (await immichJson('/shared-links')).find(l => l.key === key);
export const getAlbum = id => immichJson(`/albums/${id}?withoutAssets=true`);
export const getAlbumAssets = async albumId => {
  const assets: any[] = [];
  let nextPage = 1;
  while (nextPage) {
    const pageResult = await immichJson(
      '/search/metadata',
      jsonBody({ albumIds: [albumId], page: nextPage, size: 500, withExif: true })
    );
    assets.push(...(pageResult.assets?.items || []));
    nextPage = pageResult.assets?.nextPage ? Number(pageResult.assets.nextPage) : 0;
  }
  return assets;
};
export const addToAlbum = (albumId, ids, key) =>
  immichJson(`/albums/${albumId}/assets`, { ...jsonBody({ ids }), method: 'PUT' }, key);
export async function uploadAsset(bytes, filename, key = CFG.apiKey, takenAt) {
  const form = new FormData();
  const stamp = takenAt || new Date().toISOString();
  form.set('deviceAssetId', `isa-${crypto.createHash('sha1').update(bytes).digest('hex')}`);
  form.set('deviceId', 'immich-shared-albums');
  form.set('fileCreatedAt', stamp);
  form.set('fileModifiedAt', stamp);
  form.set('assetData', new Blob([bytes], { type: 'application/octet-stream' }), filename);
  const response = await fetch(`${CFG.immichUrl}/api/assets`, {
    method: 'POST',
    headers: { 'x-api-key': key },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`upload -> ${response.status} ${await response.text().catch(() => '')}`);
  return response.json(); // { id, status }
}

export const STUB_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64'
);

export async function applyRefMetadata(assetId: string, ref: AssetRef, key: string) {
  const meta: {
    latitude?: number;
    longitude?: number;
    description?: string;
    rating?: number;
    dateTimeOriginal?: string;
  } = {};
  if (ref.exif?.latitude != null && ref.exif?.longitude != null) {
    meta.latitude = ref.exif.latitude;
    meta.longitude = ref.exif.longitude;
  }
  const credit = ref.contributor?.displayName ? `Shared by ${ref.contributor.displayName}` : '';
  meta.description = [ref.exif?.description, credit].filter(Boolean).join('\n\n') || undefined;
  if (!meta.description) delete meta.description;
  if (ref.exif?.rating) meta.rating = ref.exif.rating;
  if (ref.takenAt) meta.dateTimeOriginal = ref.takenAt;
  if (Object.keys(meta).length) {
    try {
      await immichJson(`/assets/${assetId}`, { ...jsonBody(meta), method: 'PUT' }, key);
    } catch (e) {
      log(`metadata apply failed for ${assetId}: ${e.message}`);
    }
  }
}
