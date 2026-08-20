/** p2p/mirror.ts — creating the local mirror of a remote album. See wire-protocol.md. */
import crypto from 'node:crypto';
import { CFG, log, isUtilityEmail, BOT_PREFIX, UTILITY_EMAIL_DOMAIN } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, save } from '../state.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { ensureLocalAccountFor, syncAvatar, slugify } from '../immich/contributors.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { pullCanonicalComments } from '../sync/comments.ts';

export type MirrorRequest = {
  peer: Peer;
  album: { id: string; name: string };
  permissions: 'view' | 'contribute';
  albumOwnerName?: string;
  albumOwnerId?: string;
  remoteMappingId?: string;
  forUserIds?: string[];
  via?: 'link' | 'invite';
};

export async function ensureMirror(req: MirrorRequest): Promise<{ mapping: Mapping; created: boolean }> {
  const { peer, album, permissions, forUserIds } = req;
  const ownerName = req.albumOwnerName || peer.name;
  const hostSlug = req.albumOwnerId ? `${BOT_PREFIX.person}${req.albumOwnerId}` : slugify(ownerName);
  const host = await ensureLocalAccountFor(
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
  await syncAvatar(host, peer.url, req.albumOwnerId);

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
    const addedCount = await addMembers(existing.albumId);
    if (addedCount) log(`added ${addedCount} member(s) to existing mirror "${existing.albumName}"`);
    return { mapping: existing, created: false };
  }

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
    const addedCount = await addMembers(mirror.id);
    log(
      `mirror shared with ${forUserIds?.length ? forUserIds.length + ' named user(s)' : addedCount + ' household member(s)'}`
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

export function fillMirrorInBackground(mapping: Mapping, peer: Peer) {
  void (async () => {
    try {
      await reconcileMapping(mapping, peer);
      await pullCanonicalComments(mapping, peer);
    } catch (e) {
      log(`post-join sync error: ${e.message} — the loops will retry`);
    }
  })();
}
