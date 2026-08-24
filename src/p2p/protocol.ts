/**
 * p2p/protocol.ts — inbound wire-protocol handlers (owner side mostly): redeem an invite,
 * accept pushed refs, answer the version/manifest/comment handshakes, and act on a nudge.
 * Each returns [statusCode, jsonBody] for p2p/routes.ts to frame.
 *
 * Two invariants every handler here keeps:
 *  - The transport proves WHO is calling (mutual TLS on the household keys); it never
 *    selects anything. Mappings are always looked up WITH the caller's key, so a peer can
 *    only ever act on the albums it was invited to — never on another household's mapping.
 *  - A nudge is a hint, never a source. It can say "something changed"; it can never say
 *    where to fetch the change from. See handleNudge.
 */
import crypto from 'node:crypto';
import { CFG, SIDECAR_VERSION, log } from '../config.ts';
import { PROTOCOL_FEATURES } from '../types.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save, keys } from '../state.ts';
import { nudgePeers, peerByPub, mappingFor } from '../peers.ts';
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

/** Who are you, protocol-wise. Enrolment-free on purpose: it carries nothing private and a
 *  dialer needs it BEFORE deciding whether the two of you can talk at all. */
export function handleHello() {
  return [200, { protocol: PROTOCOL_VERSION, version: SIDECAR_VERSION, features: PROTOCOL_FEATURES }];
}

/**
 * A member says it has left an album — the courtesy signal that lets the origin stop
 * pushing to a household that is gone. Trust-minimal: it only retires the caller's OWN
 * mapping, and only marks it dead (a re-join or re-invite revives the relationship the
 * normal ways). v2 members that never call it merely keep the old one-sided behaviour.
 */
export function handleLeave(callerPub: string, albumMappingId: string) {
  const peer = peerByPub(callerPub);
  if (!peer) return [403, { error: 'unknown peer', code: 'unknown_peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping || mapping.dead) return [404, { error: 'unknown album mapping', code: 'unknown_mapping' }];
  mapping.dead = true;
  mapping.deadAt = new Date().toISOString();
  mapping.deadReason = 'member left';
  save();
  log(`"${peer.name}" left "${mapping.albumName}" — no longer pushing it to them`);
  return [200, { ok: true }];
}

export async function handleRedeem(callerPub: string, body: string) {
  const { shareKey, household, protocol, version, password } = JSON.parse(body);
  // The connection already proved possession of the caller's key, so the enrolled identity
  // IS callerPub — the payload only names the household. Nothing to verify, nothing to forge.
  if (!household?.name) return [400, { error: 'malformed household' }];
  if (protocol && protocol > PROTOCOL_VERSION)
    log(
      `peer "${household?.name}" speaks protocol ${protocol} > ours (${PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server`
    );
  const link = await getSharedLinkByKey(shareKey);
  if (!link || link.type !== 'ALBUM') return [404, { error: 'unknown share key', code: 'unknown_share_key' }];
  // A share link's own rules are the owner's stated intent — honour them here exactly as
  // the Immich share page does, rather than treating the key as the whole credential.
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) {
    log(`redeem refused: share link expired (${link.expiresAt})`);
    return [403, { error: 'this share link has expired', code: 'link_expired' }];
  }
  if (link.password) {
    if (!password)
      return [
        401,
        { error: 'this album is password protected', code: 'password_required', passwordRequired: true },
      ];
    if (!secretEquals(link.password, password)) {
      log(`redeem refused: wrong album password from "${household.name}"`);
      return [403, { error: 'incorrect album password', code: 'wrong_password' }];
    }
  } else if (CFG.linkJoinRequiresPassword) {
    log('redeem refused: ISA_LINK_JOIN_REQUIRES_PASSWORD is set and this link has no password');
    return [
      403,
      { error: 'this server only shares albums whose link has a password set', code: 'password_required' },
    ];
  }
  const album = await getAlbum(link.album.id);
  album.assets = await getAlbumAssets(album.id);
  if (!state.peers.some(p => p.pub === callerPub)) {
    state.peers.push({
      pub: callerPub,
      name: household.name,
      version,
      via: 'link',
      firstSeenAt: new Date().toISOString(),
    });
  } else {
    const pe = peerByPub(callerPub);
    if (pe) {
      pe.name = household.name;
      if (version) pe.version = version;
    }
  }
  // Idempotent: re-redeeming the same link must reuse the mapping, not mint another.
  // Otherwise a valid link is an unbounded state-growth lever.
  let mapping = state.mappings.find(
    mp => mp.role === 'owner' && mp.peer === callerPub && mp.albumId === album.id && !mp.dead
  );
  if (mapping) {
    mapping.permissions = link.allowUpload ? 'contribute' : 'view';
  } else {
    mapping = {
      id: crypto.randomUUID(),
      role: 'owner',
      albumId: album.id,
      albumName: album.albumName,
      peer: callerPub,
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
      household: { publicKey: keys.pub, name: CFG.name },
      album: { id: album.id, name: album.albumName, permissions: link.allowUpload ? 'contribute' : 'view' },
      albumOwner,
      manifest,
      mappingId: mapping.id,
    },
  ];
}
// 404 means "try again" (transient, or a mapping the caller mis-addressed); 410 means the
// relationship is OVER — the receiver should tear down its side rather than retry forever.
const goneOr404 = (peerPub: string, albumMappingId: string) => {
  const dead = state.mappings.find(
    mp =>
      mp.peer === peerPub &&
      mp.dead &&
      (mp.id === albumMappingId || mp.albumId === albumMappingId || mp.remoteAlbumId === albumMappingId)
  );
  return dead
    ? [410, { error: 'this share has ended', code: 'gone' }]
    : [404, { error: 'unknown album mapping', code: 'unknown_mapping' }];
};

export async function handleRefs(callerPub: string, body: string, albumMappingId: string) {
  const peer = peerByPub(callerPub);
  if (!peer) return [403, { error: 'unknown peer', code: 'unknown_peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId);
  if (!mapping || mapping.dead) return goneOr404(peer.pub, albumMappingId);
  // the share link's "allow public user to upload" switch, honoured cross-server
  if (mapping.permissions === 'view')
    return [403, { error: 'view-only album — uploads not allowed', code: 'view_only' }];
  const { add = [] } = JSON.parse(body);
  const failed: string[] = [];
  for (const ref of add) {
    try {
      if (!(await materialiseRef(mapping, peer, ref))) failed.push(ref.checksum);
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
export async function handleVersion(callerPub: string, albumMappingId: string) {
  const peer = peerByPub(callerPub);
  if (!peer) return [403, { error: 'unknown peer', code: 'unknown_peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping || mapping.dead) return goneOr404(peer.pub, albumMappingId);
  const stats = await immichJson(`/activities/statistics?albumId=${mapping.albumId}`).catch(() => null);
  const album = await getAlbum(mapping.albumId);
  // `version` is an OPAQUE equality token. The packed "updatedAt|assetCount" shape is kept as
  // its value for protocol-2 compatibility (updatedAt alone misses cascade deletions), but
  // receivers should read the structured fields and never parse the string.
  return [
    200,
    {
      version: `${album.updatedAt}|${album.assetCount ?? ''}`,
      updatedAt: album.updatedAt,
      assetCount: album.assetCount ?? null,
      comments: stats?.comments ?? null,
    },
  ];
}
export async function handleNudge(callerPub: string, albumMappingId: string) {
  const caller = peerByPub(callerPub);
  if (!caller) return [403, { error: 'unknown peer' }];
  const mapping = mappingFor(caller.pub, albumMappingId);
  if (!mapping || mapping.dead) return [404, { error: 'unknown album mapping' }];
  // A nudge only means "look again"; it must never get to say where to look. Scoping the
  // lookup to the caller is what enforces that — mappingFor already guarantees
  // mapping.peer === caller.pub, so the origin resolved here IS the caller. Resolving it
  // from the mapping anyway keeps that true if the lookup is ever loosened: previously the
  // caller was passed straight to the reconciler, which let any peer point another
  // household's album at a server of its choosing and materialise whatever it served.
  const origin = peerByPub(mapping.peer);
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
export async function handleManifest(callerPub: string, albumMappingId: string) {
  const peer = peerByPub(callerPub);
  if (!peer) return [403, { error: 'unknown peer', code: 'unknown_peer' }];
  const mapping = mappingFor(peer.pub, albumMappingId, 'owner');
  if (!mapping || mapping.dead) return goneOr404(peer.pub, albumMappingId);
  const manifest = await buildManifest(await getAlbumAssets(mapping.albumId));
  recordOfferedRefs(mapping.id, manifest);
  return [200, { manifest }];
}
