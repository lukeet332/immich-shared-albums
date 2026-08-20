/**
 * immich/materialise.ts — writing (and un-writing) proxy assets. materialiseRef pulls a
 * kilobyte stub and files it under the right contributor; deleteProxyAsset removes one,
 * hard-guarded so only utility-owned proxies are ever deleted.
 */
import crypto from 'node:crypto';
import { log, ROUTE_PREFIX } from '../config.ts';
import { state, seenHas, seenAdd } from '../state.ts';
import { sign } from '../peers.ts';
import { STUB_JPEG, immichJson, jsonBody, uploadAsset, addToAlbum, applyRefMetadata } from './client.ts';
import { ensureContributor } from './contributors.ts';

// Fetch a ref's preview from the peer and create the local proxy copy. Returns
// false (without marking seen) on failure so reconciliation can retry later.
export async function materialiseRef(mapping, peerUrl, fallbackName, ref) {
  if (seenHas(mapping.id, ref.checksum)) return true;
  const sigHeaders = v => ({ headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(v) } });
  // Hotlink model: nothing of the photo is stored here. The mirror asset is a ~2KB
  // unique stub that exists so the stock app has a row to render; every actual pixel
  // (thumbnails, previews, playback, originals) streams live from the owner's server
  // through the byte interceptors below. For videos the stub is a playable prefix of
  // the owner's rendition so the tile carries a real poster and duration.
  let bytes: Buffer;
  if (ref.kind === 'video') {
    const pr = await fetch(`${peerUrl}${ROUTE_PREFIX}/api/v1/assets/${ref.originAsset}/playback`, {
      ...sigHeaders(ref.originAsset),
      headers: { ...sigHeaders(ref.originAsset).headers, Range: 'bytes=0-2097151' },
      signal: AbortSignal.timeout(120000),
    });
    if (!pr.ok) {
      log(`playback stub fetch failed for ${ref.originAsset}: ${pr.status}`);
      return false;
    }
    bytes = Buffer.concat([Buffer.from(await pr.arrayBuffer()), crypto.randomBytes(8)]);
  } else {
    bytes = Buffer.concat([STUB_JPEG, crypto.randomBytes(8)]);
  }
  const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
  const c = await ensureContributor(
    ref.contributor?.displayName || fallbackName,
    mapping.albumId,
    adminKey,
    peerUrl,
    ref.contributor?.originUserId,
    mapping.peer
  );
  const ext = ref.kind === 'video' ? 'mp4' : 'jpg';
  // base64 checksums contain / and + — never let them into filenames
  const slug = ref.checksum.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const up = await uploadAsset(bytes, `shared-${slug}.${ext}`, c.key, ref.takenAt);
  await addToAlbum(mapping.albumId, [up.id], c.key);
  await applyRefMetadata(up.id, ref, c.key);
  seenAdd(mapping.id, ref.checksum, up.id, ref.originAsset);
  log(`materialised ref from "${ref.contributor?.displayName || fallbackName}" into "${mapping.albumName}"`);
  return true;
}
// Delete a materialised proxy asset. Hard guard: only utility-owned assets are ever
// deleted — resolved via the owning contributor's own key. Human photos are untouchable.
export async function deleteProxyAsset(assetId: string): Promise<boolean> {
  try {
    let asset;
    try {
      asset = await immichJson(`/assets/${assetId}`);
    } catch (e) {
      if (/-> 404/.test(e.message)) return true;
      throw e;
    } // already gone
    const owner = Object.values(state.contributors).find(c => c.userId === asset.ownerId);
    if (!owner) {
      log(`proxy delete refused for ${assetId}: owner ${asset.ownerId} is not a utility user`);
      return false;
    }
    await immichJson(
      '/assets',
      { ...jsonBody({ ids: [assetId], force: true }), method: 'DELETE' },
      owner.key
    );
    return true;
  } catch (e) {
    log(`proxy delete failed for ${assetId}: ${e.message}`);
    return false;
  }
}
