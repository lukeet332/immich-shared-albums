/**
 * p2p/protocol.ts — inbound wire-protocol handlers (owner side mostly): redeem an invite,
 * accept pushed refs, answer the version/manifest/comment handshakes, and act on a nudge.
 * Each returns [statusCode, jsonBody] for the HTTP router to send.
 *
 * Two invariants every handler here keeps:
 *  - A signature identifies a peer; it does not select one. Mappings are always looked up
 *    WITH the caller's key, so a peer can only ever act on the albums it was invited to —
 *    never on a mapping belonging to a different household.
 *  - A nudge is a hint, never a source. It can say "something changed"; it can never say
 *    where to fetch the change from. See handleNudge.
 */
import crypto from 'node:crypto';
import { CFG, SIDECAR_VERSION, log } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save } from '../state.ts';
import { verify, nudgePeers, callingPeer, mappingFor } from '../peers.ts';
import { getSharedLinkByKey, getAlbum, getAlbumAssets, ownerName, immichJson } from '../immich/client.ts';
import { buildManifest } from '../immich/refs.ts';
import { materialiseRef } from '../immich/materialise.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { pullCanonicalComments } from '../sync/comments.ts';
import { recordOfferedRefs } from './entitlement.ts';

/** Constant-time string compare that tolerates unequal lengths. */
function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export async function handleRedeem(req, body) {
  const { shareKey, household, protocol, version, password } = JSON.parse(body);
  if (!household?.publicKey || !household?.url) return [400, { error: 'malformed household' }];
  // Bind the request to the key being enrolled. This is trust-on-first-use: it proves the
  // caller holds the private half of the key it is asking us to trust, so the enrolled
  // identity cannot be forged or substituted later.
  if (!verify(body, (req.headers['x-isa-sig'] as string) || '', household.publicKey)) {
    return [403, { error: 'redeem signature does not match the household key' }];
  }
  if (protocol && protocol > PROTOCOL_VERSION)
    log(
      `peer "${household?.name}" speaks protocol ${protocol} > ours (${PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server`
    );
  const link = await getSharedLinkByKey(shareKey);
  if (!link || link.type !== 'ALBUM') return [404, { error: 'unknown share key' }];
  // A share link's own rules are the owner's stated intent — honour them here exactly as
  // the Immich share page does, rather than treating the key as the whole credential.
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    log(`redeem refused: share link expired (${link.expiresAt})`);
    return [403, { error: 'this share link has expired' }];
  }
  if (link.password) {
    if (!password) return [401, { error: 'this album is password protected', passwordRequired: true }];
    if (!secretEquals(link.password, password)) {
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
    const pe = state.peers.find(p => p.pub === household.publicKey);
    if (pe) {
      pe.url = household.url;
      pe.name = household.name;
      if (version) pe.version = version;
    }
  }
  // Idempotent: re-redeeming the same link must reuse the mapping, not mint another.
  // Otherwise a valid link is an unbounded state-growth lever.
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
  // v3 album responses carry no ownerId — the share link records its creator, which is
  // exactly "the person who shared this"; majority asset owner is the empty-proof fallback
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
      household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name },
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
  // the share link's "allow public user to upload" switch, honoured cross-server
  if (mapping.permissions === 'view') return [403, { error: 'view-only album — uploads not allowed' }];
  const { add = [] } = JSON.parse(body);
  const failed = [];
  for (const ref of add) {
    try {
      if (!(await materialiseRef(mapping, peer.url, peer.name, ref))) failed.push(ref.checksum);
    } catch (e) {
      log(`ref materialise failed (${ref.checksum?.slice(0, 10)}): ${e.message}`);
      failed.push(ref.checksum);
    }
  }
  if (add.length > failed.length) nudgePeers(mapping.albumId, peer.pub); // relay moved — tell the others
  // partial success: sender re-offers only the failed refs next cycle
  return [200, { ok: failed.length === 0, failed }];
}
// Version handshake: one cheap album read instead of a full manifest scan. Members
// compare this against their stored version and only pull the manifest on mismatch.
export async function handleVersion(req, albumMappingId) {
  const peer = callingPeer(req, albumMappingId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const stats = await immichJson(`/activities/statistics?albumId=${mapping.albumId}`).catch(() => null);
  const album = await getAlbum(mapping.albumId);
  // updatedAt alone misses cascade deletions (removing an asset from the library skips
  // the album's timestamp) — fold the asset count in so deletions move the version too
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
  // A nudge only means "look again"; it must never get to say where to look. Scoping the
  // lookup to the caller is what enforces that — mappingFor already guarantees
  // mapping.peer === caller.pub, so the origin resolved here IS the caller. Resolving it
  // from the mapping anyway keeps that true if the lookup is ever loosened: previously the
  // caller was passed straight to the reconciler, which let any peer point another
  // household's album at a server of its choosing and materialise whatever it served.
  const origin = state.peers.find(p => p.pub === mapping.peer);
  if (!origin) return [404, { error: 'unknown album mapping' }];
  // answer fast; do the pull in the background. `void` marks that as intended, not forgotten.
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
// Members re-pull this to heal refs missed at join time (e.g. preview not yet generated).
export async function handleManifest(req, albumMappingId) {
  const peer = callingPeer(req, albumMappingId);
  if (!peer) return [403, { error: 'unknown or unverified peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const manifest = await buildManifest(await getAlbumAssets(mapping.albumId));
  recordOfferedRefs(mapping.id, manifest);
  return [200, { manifest }];
}
