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
import { CFG, log } from '../config.ts';
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
  /** Restrict the mirror to one local user (per-user joins). Omit to add every human. */
  forUserId?: string;
};

/**
 * Ensure a mirror exists for `album` from `peer`. Idempotent: if one already exists this just
 * makes sure the requested local user is a member, matching the re-join behaviour.
 */
export async function ensureMirror(req: MirrorRequest): Promise<{ mapping: Mapping; created: boolean }> {
  const { peer, album, permissions, forUserId } = req;
  const ownerName = req.albumOwnerName || peer.name;
  const host = await ensureUtilityUser(ownerName);
  await syncAvatar(host, peer.url, req.albumOwnerId);

  const addMembers = async (albumId: string) => {
    let members = (await immichJson('/admin/users')).filter((u) => !u.email.endsWith('@sidecar.local'));
    if (forUserId) members = members.filter((u) => u.id === forUserId); // per-user join
    const alb = await immichJson(`/albums/${albumId}`, {}, host.key);
    const already = new Set((alb.albumUsers || []).map((au) => au.user?.id));
    members = members.filter((u) => !already.has(u.id));
    if (members.length) await immichJson(`/albums/${albumId}/users`,
      { ...jsonBody({ albumUsers: members.map((u) => ({ userId: u.id, role: 'editor' })) }), method: 'PUT' }, host.key);
    return members.length;
  };

  const existing = state.mappings.find(mp => mp.role === 'member' && mp.peer === peer.pub
    && mp.remoteAlbumId === album.id && !mp.dead);
  if (existing) {
    const n = await addMembers(existing.albumId);
    if (n) log(`added ${n} member(s) to existing mirror "${existing.albumName}"`);
    return { mapping: existing, created: false };
  }

  // a freshly-minted utility user/key can 500 its first writes on cold instances — retry
  // with backoff and log each attempt so failures are diagnosable from CI logs
  let mirror;
  for (let attempt = 1; ; attempt++) {
    try { mirror = await immichJson('/albums', jsonBody({ albumName: CFG.template.replace('{name}', album.name) }), host.key); break; }
    catch (e) {
      log(`mirror album create attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 6) throw e;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  try {
    const n = await addMembers(mirror.id);
    log(`mirror shared with ${forUserId ? 'one user (per-user join)' : n + ' household member(s)'}`);
  } catch (e) { log(`could not add local members to mirror: ${e.message}`); }

  const mapping: Mapping = { id: crypto.randomUUID(), role: 'member', albumId: mirror.id,
    albumName: mirror.albumName, peer: peer.pub, remoteAlbumId: album.id,
    remoteMappingId: req.remoteMappingId, permissions, adminSlug: slugify(ownerName) };
  state.mappings.push(mapping);
  save();
  return { mapping, created: true };
}

/**
 * Fill the mirror in behind the caller's answer. Deliberately unawaited by callers: a large
 * album or a video transcode must not hold the accept page (or a poll cycle) hostage.
 */
export function fillMirrorInBackground(mapping: Mapping, peer: Peer) {
  (async () => {
    try { await reconcileMapping(mapping, peer); await pullCanonicalComments(mapping, peer); }
    catch (e) { log(`post-join sync error: ${e.message} — the loops will retry`); }
  })();
}
