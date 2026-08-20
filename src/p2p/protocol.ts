/** p2p/protocol.ts — inbound wire handlers. See wire-protocol.md. */
import crypto from 'node:crypto';
import { CFG, SIDECAR_VERSION, log } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save, keys } from '../state.ts';
import { verify, nudgePeers, callingPeer, mappingFor } from '../peers.ts';
import { getSharedLinkByKey, getAlbum, getAlbumAssets, ownerName, immichJson } from '../immich/client.ts';
import { buildManifest } from '../immich/refs.ts';
import { tryMaterialiseRef } from '../immich/materialise.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { pullCanonicalComments } from '../sync/comments.ts';
import { recordOfferedRefs } from './entitlement.ts';

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export async function handleRedeem(req, body) {
  const { shareKey, household, protocol, version, password } = JSON.parse(body);
  if (!household?.publicKey || !household?.url) return [400, { error: 'malformed household' }];
  if (!verify(body, (req.headers['x-isa-sig'] as string) || '', household.publicKey)) {
    return [403, { error: 'redeem signature does not match the household key' }];
  }
  if (protocol && protocol > PROTOCOL_VERSION)
    log(
      `peer "${household?.name}" speaks protocol ${protocol} > ours (${PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server`
    );
  const link = await getSharedLinkByKey(shareKey);
  if (!link || link.type !== 'ALBUM') return [404, { error: 'unknown share key' }];
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    log(`redeem refused: share link expired (${link.expiresAt})`);
    return [403, { error: 'this share link has expired' }];
  }
  if (link.password) {
    if (!password) return [401, { error: 'this album is password protected', passwordRequired: true }];
    if (!constantTimeEquals(link.password, password)) {
      log(`redeem refused: wrong album password from "${household.name}"`);
      return [403, { error: 'incorrect album password' }];
    }
  } else if (CFG.requireSharePassword) {
    log('redeem refused: REQUIRE_SHARE_PASSWORD is set and this link has no password');
    return [403, { error: 'this server only shares albums whose link has a password set' }];
  }
  const album = await getAlbum(link.album.id);
  album.assets = await getAlbumAssets(album.id);
  if (!state.peers.some(p => p.pub === household.publicKey)) {
    state.peers.push({ pub: household.publicKey, url: household.url, name: household.name, version });
  } else {
    const existing = state.peers.find(p => p.pub === household.publicKey);
    if (existing) {
      existing.url = household.url;
      existing.name = household.name;
      if (version) existing.version = version;
    }
  }
  let mapping = state.mappings.find(
    mp => mp.role === 'owner' && mp.peer === household.publicKey && mp.albumId === album.id && !mp.dead
  );
  if (mapping) {
    mapping.permissions = link.allowUpload ? 'contribute' : 'view';
  } else {
    mapping = {
      id: crypto.randomUUID(),
      role: 'owner',
      albumId: album.id,
      albumName: album.albumName,
      peer: household.publicKey,
      permissions: link.allowUpload ? 'contribute' : 'view',
      via: 'link',
    };
    state.mappings.push(mapping);
    log(`peer joined: "${household.name}" -> album "${album.albumName}"`);
  }
  save();
  const manifest = await buildManifest(album.assets);
  recordOfferedRefs(mapping.id, manifest);
  const ownerCounts = {};
  for (const a of album.assets) ownerCounts[a.ownerId] = (ownerCounts[a.ownerId] || 0) + 1;
  const albumOwnerId =
    link.userId ||
    album.ownerId ||
    Object.keys(ownerCounts).sort((x, y) => ownerCounts[y] - ownerCounts[x])[0];
  const albumOwner = { displayName: (await ownerName(albumOwnerId)) || CFG.name, originUserId: albumOwnerId };
  return [
    200,
    {
      protocol: PROTOCOL_VERSION,
      version: SIDECAR_VERSION,
      household: { publicKey: keys.pub, url: CFG.publicUrl, name: CFG.name },
      album: { id: album.id, name: album.albumName, permissions: link.allowUpload ? 'contribute' : 'view' },
      albumOwner,
      manifest,
      mappingId: mapping.id,
    },
  ];
}
export async function handleRefs(req, body, albumMappingId) {
  const peer = callingPeer(req, body);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  if (mapping.permissions === 'view') return [403, { error: 'view-only album — uploads not allowed' }];
  const { add = [] } = JSON.parse(body);
  const failed: string[] = [];
  for (const ref of add) {
    try {
      if (!(await tryMaterialiseRef(mapping, peer.url, peer.name, ref))) failed.push(ref.checksum);
    } catch (e) {
      log(`ref materialise failed (${ref.checksum?.slice(0, 10)}): ${e.message}`);
      failed.push(ref.checksum);
    }
  }
  if (add.length > failed.length) nudgePeers(mapping.albumId, peer.pub);
  return [200, { ok: failed.length === 0, failed }];
}
export async function handleVersion(req, albumMappingId) {
  const peer = callingPeer(req, albumMappingId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const stats = await immichJson(`/activities/statistics?albumId=${mapping.albumId}`).catch(() => null);
  const album = await getAlbum(mapping.albumId);
  return [
    200,
    { version: `${album.updatedAt}|${album.assetCount ?? ''}`, comments: stats?.comments ?? null },
  ];
}
export async function handleNudge(req, body, albumMappingId) {
  const caller = callingPeer(req, body);
  if (!caller) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(caller.pub, albumMappingId);
  if (!mapping || mapping.dead) return [404, { error: 'unknown album mapping' }];
  const origin = state.peers.find(p => p.pub === mapping.peer);
  if (!origin) return [404, { error: 'unknown album mapping' }];
  void (async () => {
    try {
      if (mapping.role === 'member') {
        await reconcileMapping(mapping, origin);
        await pullCanonicalComments(mapping, origin);
      }
    } catch (e) {
      log(`nudge pull error on "${mapping.albumName}": ${e.message}`);
    }
  })();
  return [200, { ok: true }];
}
export async function handleManifest(req, albumMappingId) {
  const peer = callingPeer(req, albumMappingId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const manifest = await buildManifest(await getAlbumAssets(mapping.albumId));
  recordOfferedRefs(mapping.id, manifest);
  return [200, { manifest }];
}
