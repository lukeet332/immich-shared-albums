/**
 * p2p/protocol.ts — inbound wire-protocol handlers (owner side mostly): redeem an invite,
 * accept pushed refs, answer the version/manifest/comment handshakes, and act on a nudge.
 * Each returns [statusCode, jsonBody] for the HTTP router to send.
 */
import crypto from 'node:crypto';
import { CFG, SIDECAR_VERSION, log } from '../config.ts';
import { state, save } from '../state.ts';
import { verify, nudgePeers } from '../peers.ts';
import { getSharedLinkByKey, getAlbum, getAlbumAssets, ownerName, immichJson } from '../immich/client.ts';
import { buildManifest } from '../immich/refs.ts';
import { materialiseRef } from '../immich/materialise.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { pullCanonicalComments } from '../sync/comments.ts';

export async function handleRedeem(req, body) {
  const { shareKey, household, protocol, version } = JSON.parse(body);
  if (protocol && protocol > 1) log(`peer "${household?.name}" speaks protocol ${protocol} > ours (1) — update the immich-shared-albums sidecar on this server`);
  const link = await getSharedLinkByKey(shareKey);
  if (!link || link.type !== 'ALBUM') return [404, { error: 'unknown share key' }];
  const album = await getAlbum(link.album.id);
  album.assets = await getAlbumAssets(album.id);
  if (!state.peers.some(p => p.pub === household.publicKey)) {
    state.peers.push({ pub: household.publicKey, url: household.url, name: household.name, version });
  } else if (version) {
    const pe = state.peers.find(p => p.pub === household.publicKey); if (pe) pe.version = version;
  }
  const mappingId = crypto.randomUUID();
  state.mappings.push({ id: mappingId, role: 'owner', albumId: album.id, albumName: album.albumName,
    peer: household.publicKey, permissions: link.allowUpload ? 'contribute' : 'view' });
  save();
  log(`peer joined: "${household.name}" -> album "${album.albumName}"`);
  const manifest = await buildManifest(album.assets);
  // v3 album responses carry no ownerId — the share link records its creator, which is
  // exactly "the person who shared this"; majority asset owner is the empty-proof fallback
  const ownerCounts = {};
  for (const a of album.assets) ownerCounts[a.ownerId] = (ownerCounts[a.ownerId] || 0) + 1;
  const albumOwnerId = link.userId || album.ownerId || Object.keys(ownerCounts).sort((x, y) => ownerCounts[y] - ownerCounts[x])[0];
  const albumOwner = { displayName: await ownerName(albumOwnerId) || CFG.name, originUserId: albumOwnerId };
  return [200, {
    protocol: 1, version: SIDECAR_VERSION,
    household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name },
    album: { id: album.id, name: album.albumName, permissions: link.allowUpload ? 'contribute' : 'view' },
    albumOwner, manifest, mappingId,
  }];
}
export async function handleRefs(req, body, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(body, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.id === albumMappingId || m.albumId === albumMappingId || m.remoteAlbumId === albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  // the share link's "allow public user to upload" switch, honoured cross-server
  if (mapping.permissions === 'view') return [403, { error: 'view-only album — uploads not allowed' }];
  const { add = [] } = JSON.parse(body);
  const failed = [];
  for (const ref of add) {
    try { if (!(await materialiseRef(mapping, peer.url, peer.name, ref))) failed.push(ref.checksum); }
    catch (e) { log(`ref materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); failed.push(ref.checksum); }
  }
  if (add.length > failed.length) nudgePeers(mapping.albumId, peerKey); // relay moved — tell the others
  // partial success: sender re-offers only the failed refs next cycle
  return [200, { ok: failed.length === 0, failed }];
}
// Version handshake: one cheap album read instead of a full manifest scan. Members
// compare this against their stored version and only pull the manifest on mismatch.
export async function handleVersion(req, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(albumMappingId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.role === 'owner' && (m.id === albumMappingId || m.albumId === albumMappingId));
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const stats = await immichJson(`/activities/statistics?albumId=${mapping.albumId}`).catch(() => null);
  const album = await getAlbum(mapping.albumId);
  // updatedAt alone misses cascade deletions (removing an asset from the library skips
  // the album's timestamp) — fold the asset count in so deletions move the version too
  return [200, { version: `${album.updatedAt}|${album.assetCount ?? ''}`, comments: stats?.comments ?? null }];
}
export async function handleNudge(req, body, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(body, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.id === albumMappingId || m.albumId === albumMappingId || m.remoteAlbumId === albumMappingId);
  if (!mapping || mapping.dead) return [404, { error: 'unknown album mapping' }];
  // answer fast; do the pull in the background
  (async () => {
    try {
      if (mapping.role === 'member') {
        await reconcileMapping(mapping, peer);
        await pullCanonicalComments(mapping, peer);
      }
    } catch (e) { log(`nudge pull error on "${mapping.albumName}": ${e.message}`); }
  })();
  return [200, { ok: true }];
}
// Members re-pull this to heal refs missed at join time (e.g. preview not yet generated).
export async function handleManifest(req, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(albumMappingId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.role === 'owner' && (m.id === albumMappingId || m.albumId === albumMappingId));
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  return [200, { manifest: await buildManifest(await getAlbumAssets(mapping.albumId)) }];
}
