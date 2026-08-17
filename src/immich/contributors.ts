/**
 * immich/contributors.ts — per-contributor "utility" users. Materialised foreign photos
 * are owned by these bot users (keeps them out of the local timeline and preserves
 * attribution). Provisions/heals them, mints their API keys, and syncs their avatars.
 */
import crypto from 'node:crypto';
import { CFG, log, UTILITY_SUFFIX } from '../config.ts';
import { state, save } from '../state.ts';
import { immichJson, jsonBody, usersById, USERS } from './client.ts';
import { sign } from '../peers.ts';

export const slugify = (s) => (s || 'peer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'peer';
export async function ensureUtilityUser(displayName) {
  state.contributors = state.contributors || {};
  const slug = slugify(displayName);
  let c = state.contributors[slug];
  const wantedName = `${displayName}${UTILITY_SUFFIX}`;
  if (c && c.key) {                       // already fully provisioned — heal a stale display name
    const current = (await usersById(10000))[c.userId]?.name;
    if (current && current !== wantedName) {
      try {
        await immichJson(`/admin/users/${c.userId}`, { ...jsonBody({ name: wantedName }), method: 'PUT' });
        if (USERS[c.userId]) USERS[c.userId].name = wantedName;
        log(`healed utility user name: "${current}" -> "${wantedName}"`);
      } catch { /* cosmetic — retry next time */ }
    }
    return c;
  }
  const email = `shared-${slug}@sidecar.local`;
  // reuse a persisted password if we have one (survives partial-provision retries), else fresh
  const password = c?.password || crypto.randomBytes(18).toString('base64url');
  let user;
  try {
    user = await immichJson('/admin/users', jsonBody({ email, name: `${displayName} (via shared albums)`, password }));
  } catch {
    const all = await immichJson('/admin/users?withDeleted=true');
    user = all.find(u => u.email === email);
    if (!user) throw new Error(`cannot create or find contributor user ${email}`);
    if (user.deletedAt) { await immichJson(`/admin/users/${user.id}/restore`, { method: 'POST' }); log(`restored soft-deleted utility user ${email}`); }
    // admin reset: also clear shouldChangePassword so programmatic login works
    await immichJson(`/admin/users/${user.id}`, { ...jsonBody({ password, shouldChangePassword: false, name: wantedName }), method: 'PUT' });
  }
  // Instances with OAuth-only login (passwordLogin disabled) need a brief toggle to mint the key.
  let restorePasswordLoginOff = false;
  try {
    const sysCfg = await immichJson('/system-config');
    if (sysCfg.passwordLogin && sysCfg.passwordLogin.enabled === false) {
      sysCfg.passwordLogin.enabled = true;
      await immichJson('/system-config', { ...jsonBody(sysCfg), method: 'PUT' });
      restorePasswordLoginOff = true;
    }
  } catch { /* config not readable — proceed and let login speak */ }
  let login;
  try {
    login = await (await fetch(`${CFG.immichUrl}/api/auth/login`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  } finally {
    if (restorePasswordLoginOff) {
      try {
        const sysCfg = await immichJson('/system-config');
        sysCfg.passwordLogin.enabled = false;
        await immichJson('/system-config', { ...jsonBody(sysCfg), method: 'PUT' });
      } catch (e) { log(`WARNING: could not restore passwordLogin=disabled: ${e.message}`); }
    }
  }
  if (!login.accessToken) throw new Error(`login failed for ${email} — will retry`);
  const keyRes = await (await fetch(`${CFG.immichUrl}/api/api-keys`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ name: 'sidecar', permissions: ['all'] }) })).json();
  if (!keyRes.secret) throw new Error(`api-key mint failed for ${email} (${JSON.stringify(keyRes).slice(0,120)}) — will retry`);
  c = { ...(c || {}), userId: user.id, key: keyRes.secret, password };
  state.contributors[slug] = c; save();
  log(`provisioned utility user "${displayName} (via shared albums)"`);
  return c;
}
export async function syncAvatar(c, peerUrl, originUserId) {
  if (!peerUrl || !originUserId || c.avatarDone) return;
  try {
    const av = await fetch(`${peerUrl}/sidecar/api/v1/users/${originUserId}/avatar`,
      { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(originUserId) }, signal: AbortSignal.timeout(30000) });
    if (av.ok) {
      const fd = new FormData();
      fd.set('file', new Blob([Buffer.from(await av.arrayBuffer())], { type: av.headers.get('content-type') || 'image/jpeg' }), 'avatar.jpg');
      const put = await fetch(`${CFG.immichUrl}/api/users/profile-image`, { method: 'POST', headers: { 'x-api-key': c.key }, body: fd });
      if (put.ok) { c.avatarDone = true; save(); }  // only stop retrying once an avatar actually landed
    }
  } catch { /* avatars are garnish */ }
}
export async function ensureContributor(displayName, albumId, adminKey, peerUrl, originUserId) {
  const c = await ensureUtilityUser(displayName);
  if (!c.key) throw new Error(`contributor "${displayName}" has no API key yet — will retry`);
  await syncAvatar(c, peerUrl, originUserId);
  try {
    await immichJson(`/albums/${albumId}/users`, { ...jsonBody({ albumUsers: [{ userId: c.userId, role: 'editor' }] }), method: 'PUT' }, adminKey);
  } catch { /* already a member */ }
  return c;
}
