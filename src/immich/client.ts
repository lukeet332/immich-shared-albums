/**
 * immich/client.ts — the local Immich REST client. Every read/write against this
 * household's own Immich goes through here: the fetch wrapper, the users cache,
 * album/asset getters, asset upload, metadata apply, and the stub-JPEG constant.
 */
import crypto from 'node:crypto';
import { CFG, log, isUtilityEmail } from '../config.ts';
import type { AssetRef } from '../types.ts';

export const immich = async (p: string, init: RequestInit = {}, key: string = CFG.apiKey) => {
  const r = await fetch(`${CFG.immichUrl}/api${p}`, {
    signal: AbortSignal.timeout(60000),
    ...init,
    headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`immich ${p} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r;
};
export const immichJson = async (p: string, init?: RequestInit, key?: string) => {
  const r = await immich(p, init, key);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
export const jsonBody = obj => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

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
  const u = (await usersById())[ownerId];
  return u && !u.utility ? u.name : null;
}
export const getSharedLinkByKey = async key => (await immichJson('/shared-links')).find(l => l.key === key);
export const getAlbum = id => immichJson(`/albums/${id}?withoutAssets=true`);
// Immich v3 removed embedded assets from the album endpoint; search/metadata is the stable enumerator.
export const getAlbumAssets = async albumId => {
  const out: any[] = [];
  let page = 1;
  while (page) {
    const res = await immichJson(
      '/search/metadata',
      jsonBody({ albumIds: [albumId], page, size: 500, withExif: true })
    );
    out.push(...(res.assets?.items || []));
    page = res.assets?.nextPage ? Number(res.assets.nextPage) : 0;
  }
  return out;
};
export const addToAlbum = (albumId, ids, key) =>
  immichJson(`/albums/${albumId}/assets`, { ...jsonBody({ ids }), method: 'PUT' }, key);
export async function uploadAsset(bytes, filename, key = CFG.apiKey, takenAt) {
  const fd = new FormData();
  const stamp = takenAt || new Date().toISOString();
  fd.set('deviceAssetId', `isa-${crypto.createHash('sha1').update(bytes).digest('hex')}`);
  fd.set('deviceId', 'immich-shared-albums');
  fd.set('fileCreatedAt', stamp);
  fd.set('fileModifiedAt', stamp);
  fd.set('assetData', new Blob([bytes], { type: 'application/octet-stream' }), filename);
  const r = await fetch(`${CFG.immichUrl}/api/assets`, {
    method: 'POST',
    headers: { 'x-api-key': key },
    body: fd,
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`upload -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.json(); // { id, status }
}

// A minimal valid 1x1 JPEG (baseline, grey). Stubs get a random tail for uniqueness —
// Immich dedupes identical bytes per user, and every proxy must stay a distinct asset.
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

/** Album name + cover for a share key, via the unauthenticated public route — works whoever owns the link. */
export async function publicShareLinkMeta(
  key: string
): Promise<{ albumName?: string; coverAssetId?: string } | null> {
  try {
    const r = await fetch(`${CFG.immichUrl}/api/shared-links/me?key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    const link = await r.json();
    return { albumName: link.album?.albumName, coverAssetId: link.album?.albumThumbnailAssetId ?? undefined };
  } catch {
    return null;
  }
}
