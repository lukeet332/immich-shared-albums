/**
 * p2p/mirror.ts — creating the local mirror of a remote album.
 *
 * Extracted from join.ts because there are now two ways to acquire an album and only one way to
 * mirror it: redeeming a share link (join.ts), and being invited in the origin's own Immich
 * picker (sync/invites.ts). The mirror itself is identical either way — a utility user owns it
 * so it stays out of local timelines, local humans are added as editors, and the reconciler
 * fills it in behind the answer.
 */
import crypto from 'node:crypto';
import { CFG, log, isUtilityEmail, BOT_PREFIX, UTILITY_EMAIL_DOMAIN } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, save } from '../state.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { ensureUtilityUser, syncAvatar, slugify } from '../immich/contributors.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { pullCanonicalComments } from '../sync/comments.ts';

export type MirrorRequest = {
  peer: Peer;
  album: { id: string; name: string };
  permissions: 'view' | 'contribute';
  /** Display name of the album's owner on the origin; falls back to the household name. */
  albumOwnerName?: string;
  /** Origin user id, for syncing that person's avatar onto the local utility user. */
  albumOwnerId?: string;
  /** The origin's own mapping id, when known (link joins carry it; invitations do not). */
  remoteMappingId?: string;
  /** Restrict the mirror to these local users (per-person invitations). Omit to add every
   *  human, which is what a link join does — a link is redeemed BY someone, for the household. */
  forUserIds?: string[];
  /** How this share was acquired. Scopes member-side withdrawal: only invitation-created
   *  mirrors may be torn down when an invitation stops being offered. */
  via?: 'link' | 'invite';
};

/**
 * Ensure a mirror exists for `album` from `peer`. Idempotent: if one already exists this just
 * makes sure the requested local user is a member, matching the re-join behaviour.
 */
export async function ensureMirror(req: MirrorRequest): Promise<{ mapping: Mapping; created: boolean }> {
  const { peer, album, permissions, forUserIds } = req;
  const ownerName = req.albumOwnerName || peer.name;
  // The album's owner is a person on that peer, so key them by their id on THEIR server when we
  // know it. That makes the account we create here and the one the directory creates the same
  // human rather than two picker entries for one person. `homePeer` is deliberately NOT set: a
  // redeem does not prove where they live, only a directory does.
  const hostSlug = req.albumOwnerId ? `${BOT_PREFIX.person}${req.albumOwnerId}` : slugify(ownerName);
  const host = await ensureUtilityUser(
    ownerName,
    req.albumOwnerId
      ? {
          peerPub: peer.pub,
          peerUserId: req.albumOwnerId,
          stateKey: hostSlug,
          email: `${hostSlug}@${UTILITY_EMAIL_DOMAIN}`,
        }
      : { peerPub: peer.pub }
  );
  await syncAvatar(host, peer, req.albumOwnerId);

  const addMembers = async (albumId: string) => {
    let members = (await immichJson('/admin/users')).filter(u => !isUtilityEmail(u.email));
    if (forUserIds?.length) members = members.filter(u => forUserIds.includes(u.id));
    const alb = await immichJson(`/albums/${albumId}`, {}, host.key);
    const already = new Set((alb.albumUsers || []).map(au => au.user?.id));
    members = members.filter(u => !already.has(u.id));
    if (members.length)
      await immichJson(
        `/albums/${albumId}/users`,
        { ...jsonBody({ albumUsers: members.map(u => ({ userId: u.id, role: 'editor' })) }), method: 'PUT' },
        host.key
      );
    return members.length;
  };

  const existing = state.mappings.find(
    mp => mp.role === 'member' && mp.peer === peer.pub && mp.remoteAlbumId === album.id && !mp.dead
  );
  if (existing) {
    const n = await addMembers(existing.albumId);
    if (n) log(`added ${n} member(s) to existing mirror "${existing.albumName}"`);
    return { mapping: existing, created: false };
  }

  // a freshly-minted utility user/key can 500 its first writes on cold instances — retry
  // with backoff and log each attempt so failures are diagnosable from CI logs
  let mirror;
  for (let attempt = 1; ; attempt++) {
    try {
      mirror = await immichJson(
        '/albums',
        jsonBody({ albumName: CFG.template.replace('{name}', album.name) }),
        host.key
      );
      break;
    } catch (e) {
      log(`mirror album create attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 6) throw e;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  try {
    const n = await addMembers(mirror.id);
    log(
      `mirror shared with ${forUserIds?.length ? forUserIds.length + ' named user(s)' : n + ' household member(s)'}`
    );
  } catch (e) {
    log(`could not add local members to mirror: ${e.message}`);
  }

  const mapping: Mapping = {
    id: crypto.randomUUID(),
    role: 'member',
    albumId: mirror.id,
    albumName: mirror.albumName,
    peer: peer.pub,
    remoteAlbumId: album.id,
    remoteMappingId: req.remoteMappingId,
    permissions,
    adminSlug: hostSlug,
    via: req.via ?? 'link',
  };
  state.mappings.push(mapping);
  save();
  return { mapping, created: true };
}

/**
 * Fill the mirror in behind the caller's answer. Deliberately unawaited by callers: a large
 * album or a video transcode must not hold the accept page (or a poll cycle) hostage.
 */
export function fillMirrorInBackground(mapping: Mapping, peer: Peer) {
  // `void`: deliberately not awaited — a large album or a transcode must not block the caller.
  void (async () => {
    try {
      await reconcileMapping(mapping, peer);
      await pullCanonicalComments(mapping, peer);
    } catch (e) {
      log(`post-join sync error: ${e.message} — the loops will retry`);
    }
  })();
}
