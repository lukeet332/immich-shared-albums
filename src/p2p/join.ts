/**
 * p2p/join.ts — the member side of joining. Redeems a share link against the origin,
 * pins the peer, provisions the host utility user, creates the local mirror album, and
 * kicks off the first reconcile. Idempotent: re-joining just adds the user to the mirror.
 */
import crypto from 'node:crypto';
import { CFG, SIDECAR_VERSION, log } from '../config.ts';
import { state, save } from '../state.ts';
import { signedFetch, assertPeerUrlAllowed } from '../peers.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { ensureUtilityUser, syncAvatar, slugify } from '../immich/contributors.ts';
import { reconcileMapping } from '../sync/engine.ts';
import { pullCanonicalComments } from '../sync/comments.ts';

export async function join(shareUrl, forUserId, password?: string) {
  const m = String(shareUrl ?? '').trim().match(/^(https?:\/\/[^/]+)\/share\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('that does not look like an Immich share link');
  const [, origin, shareKey] = m;
  await assertPeerUrlAllowed(origin);
  const body = JSON.stringify({ shareKey, protocol: 1, version: SIDECAR_VERSION, password,
    household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name } });
  const r = await signedFetch(`${origin}/sidecar/api/v1/invites/redeem`, body);
  if (!r.ok) {
    // Surface the other sidecar's own message (an expired link, a wrong password) but
    // never an arbitrary upstream body — that would make this a read primitive for
    // whatever the URL actually pointed at.
    const reply = await r.json().catch(() => null);
    const clean = typeof reply?.error === 'string' ? reply.error.slice(0, 200) : null;
    const err = new Error(clean || `the other server refused the join (${r.status})`);
    if (reply?.passwordRequired) (err as Error & { passwordRequired?: boolean }).passwordRequired = true;
    throw err;
  }
  const res = await r.json();
  if (res.protocol && res.protocol > 1) log(`origin "${res.household?.name}" speaks protocol ${res.protocol} > ours (1) — update the immich-shared-albums sidecar on this server`);
  if (!state.peers.some(p => p.pub === res.household.publicKey)) {
    state.peers.push({ pub: res.household.publicKey, url: res.household.url, name: res.household.name, version: res.version });
  }
  const host = await ensureUtilityUser(res.albumOwner?.displayName || res.household.name);
  await syncAvatar(host, res.household.url, res.albumOwner?.originUserId);
  const addMembers = async (albumId) => {
    let members = (await immichJson('/admin/users')).filter(u => !u.email.endsWith('@sidecar.local'));
    if (forUserId) members = members.filter(u => u.id === forUserId); // per-user join: only the receiving user
    const alb = await immichJson(`/albums/${albumId}`, {}, host.key);
    const already = new Set((alb.albumUsers || []).map(au => au.user?.id));
    members = members.filter(u => !already.has(u.id));
    if (members.length) await immichJson(`/albums/${albumId}/users`,
      { ...jsonBody({ albumUsers: members.map(u => ({ userId: u.id, role: 'editor' })) }), method: 'PUT' }, host.key);
    return members.length;
  };
  // same remote album already mirrored here -> just add this user to the existing mirror
  const existing = state.mappings.find(mp => mp.role === 'member' && mp.peer === res.household.publicKey
    && mp.remoteAlbumId === res.album.id && !mp.dead);
  if (existing) {
    const n = await addMembers(existing.albumId);
    log(`re-join: added ${n} member(s) to existing mirror "${existing.albumName}"`);
    return { album: existing.albumName, albumId: existing.albumId, photos: res.manifest.length, from: res.household.name, permissions: res.album.permissions, mappingId: existing.id };
  }
  // a freshly-minted utility user/key can 500 its first writes on cold instances — retry
  // with backoff and log each attempt so failures are diagnosable from CI logs
  let mirror;
  for (let attempt = 1; ; attempt++) {
    try { mirror = await immichJson('/albums', jsonBody({ albumName: CFG.template.replace('{name}', res.album.name) }), host.key); break; }
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
  const mappingId = crypto.randomUUID();
  state.mappings.push({ id: mappingId, role: 'member', albumId: mirror.id, albumName: mirror.albumName,
    peer: res.household.publicKey, remoteAlbumId: res.album.id, remoteMappingId: res.mappingId,
    permissions: res.album.permissions, adminSlug: slugify(res.albumOwner?.displayName || res.household.name) });
  save();
  log(`joined "${res.album.name}" from "${res.household.name}" (${res.manifest.length} photos)`);
  // the join answers immediately — materialisation happens right behind it via the
  // reconciler (a big album or video transcode must not hold the accept page hostage)
  const newMapping = state.mappings.find(mp => mp.id === mappingId);
  const peerRec = state.peers.find(pe => pe.pub === res.household.publicKey);
  if (newMapping && peerRec) {
    (async () => {
      try { await reconcileMapping(newMapping, peerRec); await pullCanonicalComments(newMapping, peerRec); }
      catch (e) { log(`post-join sync error: ${e.message} — the loops will retry`); }
    })();
  }
  return { album: mirror.albumName, albumId: mirror.id, photos: res.manifest.length, from: res.household.name, permissions: res.album.permissions, mappingId };
}
