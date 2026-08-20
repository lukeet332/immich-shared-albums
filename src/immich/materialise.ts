/** immich/materialise.ts — writing and un-writing proxy assets; only utility-owned proxies are deletable. See local-immich-api.md. */
import crypto from 'node:crypto';
import { log, ROUTE_PREFIX } from '../config.ts';
import { state, seenHas, seenAdd, keys } from '../state.ts';
import { sign } from '../peers.ts';
import { STUB_JPEG, immichJson, jsonBody, uploadAsset, addToAlbum, applyRefMetadata } from './client.ts';
import { ensureContributor } from './contributors.ts';

export async function tryMaterialiseRef(mapping, peerUrl, fallbackName, ref) {
  if (seenHas(mapping.id, ref.checksum)) return true;
  const sigHeaders = v => ({ headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(v) } });
  let bytes: Buffer;
  if (ref.kind === 'video') {
    const playbackResponse = await fetch(
      `${peerUrl}${ROUTE_PREFIX}/api/v1/assets/${ref.originAsset}/playback`,
      {
        ...sigHeaders(ref.originAsset),
        headers: { ...sigHeaders(ref.originAsset).headers, Range: 'bytes=0-2097151' },
        signal: AbortSignal.timeout(120000),
      }
    );
    if (!playbackResponse.ok) {
      log(`playback stub fetch failed for ${ref.originAsset}: ${playbackResponse.status}`);
      return false;
    }
    bytes = Buffer.concat([Buffer.from(await playbackResponse.arrayBuffer()), crypto.randomBytes(8)]);
  } else {
    bytes = Buffer.concat([STUB_JPEG, crypto.randomBytes(8)]);
  }
  const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
  const contributorId = ref.contributor?.originUserId;
  const missingMemberMeansRevoked =
    mapping.via === 'invite' && !!contributorId && (mapping.forPeerUserIds || []).includes(contributorId);
  const contributor = await ensureContributor(
    ref.contributor?.displayName || fallbackName,
    mapping.albumId,
    adminKey,
    peerUrl,
    contributorId,
    mapping.peer,
    { reAddIfMissing: !missingMemberMeansRevoked }
  );
  const ext = ref.kind === 'video' ? 'mp4' : 'jpg';
  const fileSafeChecksum = ref.checksum.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const uploaded = await uploadAsset(
    bytes,
    `shared-${fileSafeChecksum}.${ext}`,
    contributor.key,
    ref.takenAt
  );
  await addToAlbum(mapping.albumId, [uploaded.id], contributor.key);
  await applyRefMetadata(uploaded.id, ref, contributor.key);
  seenAdd(mapping.id, ref.checksum, uploaded.id, ref.originAsset);
  log(`materialised ref from "${ref.contributor?.displayName || fallbackName}" into "${mapping.albumName}"`);
  return true;
}
export async function deleteProxyAsset(assetId: string): Promise<boolean> {
  try {
    let asset;
    try {
      asset = await immichJson(`/assets/${assetId}`);
    } catch (e) {
      if (/-> 404/.test(e.message)) return true;
      throw e;
    } // already gone
    const owner = Object.values(state.contributors).find(a => a.userId === asset.ownerId);
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
