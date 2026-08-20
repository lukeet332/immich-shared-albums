/** immich/contributors.ts — the local accounts that stand in for people on other servers. See contributors.md. */
import crypto from 'node:crypto';
import { CFG, log, UTILITY_SUFFIX, ROUTE_PREFIX, UTILITY_EMAIL_DOMAIN, BOT_PREFIX } from '../config.ts';
import { state, save, keys, addedRecord } from '../state.ts';
import { immichJson, jsonBody, usersById, USERS } from './client.ts';
import { sign } from '../peers.ts';

export const slugify = s =>
  (s || 'peer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'peer';

const ACCOUNT_PERMISSIONS = [
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
export async function ensureLocalAccountFor(
  displayName,
  opts: {
    peerPub?: string;
    peerUserId?: string;
    stateKey?: string;
    email?: string;
    fullName?: string;
    homePeer?: string;
  } = {}
) {
  const { peerPub, peerUserId } = opts;
  const slug = opts.stateKey || slugify(displayName);
  let account = state.contributors[slug];
  const wantedName = opts.fullName || `${displayName}${UTILITY_SUFFIX}`;
  if (account && account.key) {
    if (opts.homePeer && account.homePeer !== opts.homePeer) {
      account.homePeer = opts.homePeer;
      save();
    }
    if ((peerPub && account.peer !== peerPub) || (peerUserId && account.peerUserId !== peerUserId)) {
      account.peer = peerPub ?? account.peer;
      account.peerUserId = peerUserId ?? account.peerUserId;
      save();
    }
    const directoryOwnsName = !!account.homePeer && !opts.fullName;
    const current = (await usersById(10000))[account.userId]?.name;
    if (!directoryOwnsName && current && current !== wantedName) {
      try {
        await immichJson(`/admin/users/${account.userId}`, {
          ...jsonBody({ name: wantedName }),
          method: 'PUT',
        });
        if (USERS[account.userId]) USERS[account.userId].name = wantedName;
        log(`healed utility user name: "${current}" -> "${wantedName}"`);
      } catch {
        /* cosmetic — retry next time */
      }
    }
    return account;
  }
  const email = opts.email || `${BOT_PREFIX.helper}${slug}@${UTILITY_EMAIL_DOMAIN}`;
  const password = account?.password || crypto.randomBytes(18).toString('base64url');
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
    await immichJson(`/admin/users/${user.id}`, {
      ...jsonBody({ password, shouldChangePassword: false, name: wantedName }),
      method: 'PUT',
    });
  }
  let mustRestorePasswordLoginDisabled = false;
  try {
    const sysCfg = await immichJson('/system-config');
    if (sysCfg.passwordLogin && sysCfg.passwordLogin.enabled === false) {
      sysCfg.passwordLogin.enabled = true;
      await immichJson('/system-config', { ...jsonBody(sysCfg), method: 'PUT' });
      mustRestorePasswordLoginDisabled = true;
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
    if (mustRestorePasswordLoginDisabled) {
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
      body: JSON.stringify({ name: 'immich-shared-albums', permissions: ACCOUNT_PERMISSIONS }),
    })
  ).json();
  if (!keyRes.secret)
    throw new Error(
      `api-key mint failed for ${email} (${JSON.stringify(keyRes).slice(0, 120)}) — will retry`
    );
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
  account = {
    ...(account || {}),
    userId: user.id,
    key: keyRes.secret,
    peer: peerPub ?? account?.peer,
    peerUserId: peerUserId ?? account?.peerUserId,
    homePeer: opts.homePeer ?? account?.homePeer,
  };
  if (!passwordRetired)
    account.password = password; // keep it only if the roll failed, so a retry can resume
  else delete account.password;
  state.contributors[slug] = account;
  save();
  log(
    `provisioned utility user "${displayName} (via shared albums)" (scoped key${passwordRetired ? ', no login' : ''})`
  );
  return account;
}
export async function syncAvatar(account, peerUrl, originUserId) {
  if (!peerUrl || !originUserId || account.avatarDone) return;
  try {
    const avatarResponse = await fetch(`${peerUrl}${ROUTE_PREFIX}/api/v1/users/${originUserId}/avatar`, {
      headers: { 'x-isa-key': keys.pub, 'x-isa-sig': sign(originUserId) },
      signal: AbortSignal.timeout(30000),
    });
    if (avatarResponse.ok) {
      const form = new FormData();
      form.set(
        'file',
        new Blob([Buffer.from(await avatarResponse.arrayBuffer())], {
          type: avatarResponse.headers.get('content-type') || 'image/jpeg',
        }),
        'avatar.jpg'
      );
      const put = await fetch(`${CFG.immichUrl}/api/users/profile-image`, {
        method: 'POST',
        headers: { 'x-api-key': account.key },
        body: form,
      });
      if (put.ok) {
        account.avatarDone = true;
        save();
      } // only stop retrying once an avatar actually landed
    }
  } catch {
    /* avatars are garnish */
  }
}
// ORDER IS LOAD-BEARING: read, then record, then add. contributors.md.
export async function ensureContributor(
  displayName,
  albumId,
  adminKey,
  peerUrl,
  originUserId,
  peerPub?: string,
  opts: { reAddIfMissing?: boolean } = {}
) {
  const account = await ensureLocalAccountFor(
    displayName,
    originUserId
      ? {
          peerPub,
          peerUserId: originUserId,
          stateKey: `${BOT_PREFIX.person}${originUserId}`,
          email: `${BOT_PREFIX.person}${originUserId}@${UTILITY_EMAIL_DOMAIN}`,
        }
      : { peerPub, peerUserId: originUserId }
  );
  if (!account.key) throw new Error(`contributor "${displayName}" has no API key yet — will retry`);
  await syncAvatar(account, peerUrl, originUserId);

  let alreadyMember = false;
  try {
    const alb = await immichJson(`/albums/${albumId}?withoutAssets=true`, {}, adminKey);
    alreadyMember = (alb.albumUsers || []).some(au => au.user?.id === account.userId);
  } catch {
    return account;
  }
  if (!alreadyMember && opts.reAddIfMissing === false) {
    log(`"${displayName}" is no longer a member of this album — not re-adding (revoked)`);
    return account;
  }
  if (!alreadyMember) {
    addedRecord(albumId, account.userId);
    try {
      await immichJson(
        `/albums/${albumId}/users`,
        { ...jsonBody({ albumUsers: [{ userId: account.userId, role: 'editor' }] }), method: 'PUT' },
        adminKey
      );
    } catch (e) {
      log(`could not add "${displayName}" to the album: ${e.message} — will retry`);
    }
  }
  return account;
}
