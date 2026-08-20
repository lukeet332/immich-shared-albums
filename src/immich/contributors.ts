/**
 * immich/contributors.ts — per-contributor "utility" users. Materialised foreign photos
 * are owned by these bot users (keeps them out of the local timeline and preserves
 * attribution). Provisions/heals them, mints their API keys, and syncs their avatars.
 */
import crypto from 'node:crypto';
import { CFG, log, UTILITY_SUFFIX, ROUTE_PREFIX, UTILITY_EMAIL_DOMAIN, BOT_PREFIX } from '../config.ts';
import { state, save, keys } from '../state.ts';
import { immichJson, jsonBody, usersById, USERS } from './client.ts';
import { sign } from '../peers.ts';

export const slugify = s =>
  (s || 'peer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'peer';

/**
 * Exactly what a utility user does, and nothing else. These are non-admin accounts, so an
 * "all" key was never admin-equivalent — but it still granted every action that user could
 * take, on a credential that sits in state.db. This is the list the sidecar actually
 * exercises: own the stubs, curate the mirror album, mirror comments, carry an avatar.
 */
const UTILITY_PERMISSIONS = [
  'asset.upload',
  'asset.read',
  'asset.update',
  'asset.delete',
  'asset.download',
  'album.create',
  'album.read',
  'album.update',
  'album.delete',
  'albumAsset.create',
  'albumAsset.delete',
  'albumUser.create',
  'albumUser.update',
  'albumUser.delete',
  'activity.create',
  'activity.read',
  'activity.delete',
  'activity.statistics',
  'user.read',
  'user.update',
  'userProfileImage.create',
  'userProfileImage.update',
];
/**
 * Provision (or heal) a utility user.
 *
 * `opts` exists because there are two KINDS of utility user and conflating them is unsafe:
 *  - contributors (default) own stubs and carry attribution. The sidecar adds them to albums
 *    itself, so their album membership means "this person contributed here".
 *  - invite targets (`stateKey`/`email`/`fullName` supplied) exist ONLY to be picked by a human
 *    in Immich's album picker. The sidecar never adds them to an album, so their membership is
 *    unambiguous intent — which is exactly what invitation detection needs.
 * Giving them separate email prefixes and state keys keeps the two from ever being mistaken for
 * one another. An earlier attempt to reuse contributors as invite targets turned every
 * link-shared album into a bogus invitation and corrupted sync.
 */
export async function ensureUtilityUser(
  displayName,
  opts: {
    peerPub?: string;
    peerUserId?: string;
    stateKey?: string;
    email?: string;
    fullName?: string;
  } = {}
) {
  const { peerPub, peerUserId } = opts;
  const slug = opts.stateKey || slugify(displayName);
  let c = state.contributors[slug];
  const wantedName = opts.fullName || `${displayName}${UTILITY_SUFFIX}`;
  if (c && c.key) {
    // already fully provisioned — heal a stale display name
    if ((peerPub && c.peer !== peerPub) || (peerUserId && c.peerUserId !== peerUserId)) {
      c.peer = peerPub ?? c.peer;
      c.peerUserId = peerUserId ?? c.peerUserId;
      save();
    }
    const current = (await usersById(10000))[c.userId]?.name;
    if (current && current !== wantedName) {
      try {
        await immichJson(`/admin/users/${c.userId}`, { ...jsonBody({ name: wantedName }), method: 'PUT' });
        if (USERS[c.userId]) USERS[c.userId].name = wantedName;
        log(`healed utility user name: "${current}" -> "${wantedName}"`);
      } catch {
        /* cosmetic — retry next time */
      }
    }
    return c;
  }
  const email = opts.email || `${BOT_PREFIX.contributor}${slug}@${UTILITY_EMAIL_DOMAIN}`;
  // reuse a persisted password if we have one (survives partial-provision retries), else fresh
  const password = c?.password || crypto.randomBytes(18).toString('base64url');
  let user;
  try {
    user = await immichJson('/admin/users', jsonBody({ email, name: wantedName, password }));
  } catch {
    const all = await immichJson('/admin/users?withDeleted=true');
    user = all.find(u => u.email === email);
    if (!user) throw new Error(`cannot create or find contributor user ${email}`);
    if (user.deletedAt) {
      await immichJson(`/admin/users/${user.id}/restore`, { method: 'POST' });
      log(`restored soft-deleted utility user ${email}`);
    }
    // admin reset: also clear shouldChangePassword so programmatic login works
    await immichJson(`/admin/users/${user.id}`, {
      ...jsonBody({ password, shouldChangePassword: false, name: wantedName }),
      method: 'PUT',
    });
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
  } catch {
    /* config not readable — proceed and let login speak */
  }
  let login;
  try {
    login = await (
      await fetch(`${CFG.immichUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    ).json();
  } finally {
    if (restorePasswordLoginOff) {
      try {
        const sysCfg = await immichJson('/system-config');
        sysCfg.passwordLogin.enabled = false;
        await immichJson('/system-config', { ...jsonBody(sysCfg), method: 'PUT' });
      } catch (e) {
        log(`WARNING: could not restore passwordLogin=disabled: ${e.message}`);
      }
    }
  }
  if (!login.accessToken) throw new Error(`login failed for ${email} — will retry`);
  const keyRes = await (
    await fetch(`${CFG.immichUrl}/api/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ name: 'immich-shared-albums', permissions: UTILITY_PERMISSIONS }),
    })
  ).json();
  if (!keyRes.secret)
    throw new Error(
      `api-key mint failed for ${email} (${JSON.stringify(keyRes).slice(0, 120)}) — will retry`
    );
  // The password existed only to mint that key. Roll it to a value we never keep, so these
  // accounts stop being sign-in-able at all: from here the sidecar holds a scoped API key
  // and nothing that can open an interactive session. A stored password would otherwise be
  // a standing login to your server, sitting in state.db, for a bot that never needs one.
  let passwordRetired = false;
  try {
    await immichJson(`/admin/users/${user.id}`, {
      ...jsonBody({ password: crypto.randomBytes(24).toString('base64url'), shouldChangePassword: false }),
      method: 'PUT',
    });
    passwordRetired = true;
  } catch (e) {
    log(`WARNING: could not retire the login password for ${email}: ${e.message}`);
  }
  if (CFG.utilityQuotaMb > 0) {
    try {
      await immichJson(`/admin/users/${user.id}`, {
        ...jsonBody({ quotaSizeInBytes: CFG.utilityQuotaMb * 1024 * 1024 }),
        method: 'PUT',
      });
    } catch (e) {
      log(`could not set utility quota for ${email}: ${e.message}`);
    }
  }
  c = {
    ...(c || {}),
    userId: user.id,
    key: keyRes.secret,
    peer: peerPub ?? c?.peer,
    peerUserId: peerUserId ?? c?.peerUserId,
  };
  if (!passwordRetired)
    c.password = password; // keep it only if the roll failed, so a retry can resume
  else delete c.password;
  state.contributors[slug] = c;
  save();
  log(
    `provisioned utility user "${displayName} (via shared albums)" (scoped key${passwordRetired ? ', no login' : ''})`
  );
  return c;
}
export async function syncAvatar(c, peerUrl, originUserId) {
  if (!peerUrl || !originUserId || c.avatarDone) return;
  try {
    const av = await fetch(`${peerUrl}${ROUTE_PREFIX}/api/v1/users/${originUserId}/avatar`, {
      headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(originUserId) },
      signal: AbortSignal.timeout(30000),
    });
    if (av.ok) {
      const fd = new FormData();
      fd.set(
        'file',
        new Blob([Buffer.from(await av.arrayBuffer())], {
          type: av.headers.get('content-type') || 'image/jpeg',
        }),
        'avatar.jpg'
      );
      const put = await fetch(`${CFG.immichUrl}/api/users/profile-image`, {
        method: 'POST',
        headers: { 'x-api-key': c.key },
        body: fd,
      });
      if (put.ok) {
        c.avatarDone = true;
        save();
      } // only stop retrying once an avatar actually landed
    }
  } catch {
    /* avatars are garnish */
  }
}
export async function ensureContributor(
  displayName,
  albumId,
  adminKey,
  peerUrl,
  originUserId,
  peerPub?: string
) {
  const c = await ensureUtilityUser(displayName, { peerPub });
  if (!c.key) throw new Error(`contributor "${displayName}" has no API key yet — will retry`);
  await syncAvatar(c, peerUrl, originUserId);
  try {
    await immichJson(
      `/albums/${albumId}/users`,
      { ...jsonBody({ albumUsers: [{ userId: c.userId, role: 'editor' }] }), method: 'PUT' },
      adminKey
    );
  } catch {
    /* already a member */
  }
  return c;
}
