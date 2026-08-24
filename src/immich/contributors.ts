/**
 * immich/contributors.ts — per-contributor "utility" users. Materialised foreign photos
 * are owned by these bot users (keeps them out of the local timeline and preserves
 * attribution). Provisions/heals them, mints their API keys, and syncs their avatars.
 */
import crypto from 'node:crypto';
import { CFG, log, UTILITY_SUFFIX, UTILITY_EMAIL_DOMAIN, BOT_PREFIX } from '../config.ts';
import { state, save, addedRecord } from '../state.ts';
import { immichJson, jsonBody, usersById, USERS } from './client.ts';
import { peerByteRequest, recvIterable } from '../p2p/transport.ts';

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
    /** Always `person-<their user id on their own server>` — never derived from a display
     *  name. Names are mutable and collide; ids are neither. */
    stateKey: string;
    email: string;
    fullName?: string;
    /** The server this person lives on. Set ONLY by the directory sync. */
    homePeer?: string;
  }
) {
  const { peerPub, peerUserId } = opts;
  const slug = opts.stateKey;
  let c = state.contributors[slug];
  const wantedName = opts.fullName || `${displayName}${UTILITY_SUFFIX}`;
  if (c && c.apiKey) {
    // already fully provisioned — heal a stale display name.
    // Only a directory may say where someone lives. A relayed ref knows the person's id but not
    // their server, so it must never set or move `homePeer` — that is what stops an album shared
    // with a person at D from being handed to the C it travelled through.
    // One save for all record healing — a crash must never split homePeer from the rest.
    if (
      (opts.homePeer && c.homePeer !== opts.homePeer) ||
      (peerPub && c.viaPeer !== peerPub) ||
      (peerUserId && c.peerUserId !== peerUserId)
    ) {
      if (opts.homePeer) c.homePeer = opts.homePeer;
      c.viaPeer = peerPub ?? c.viaPeer;
      c.peerUserId = peerUserId ?? c.peerUserId;
      save();
    }
    // The directory owns the name of anyone it has placed: it is the only caller that knows
    // which server to name. An attribution ref arriving later must not rename them back to the
    // generic suffix, or the two would overwrite each other on every poll.
    const directoryOwnsName = !!c.homePeer && !opts.fullName;
    const current = (await usersById(10000))[c.userId]?.name;
    if (!directoryOwnsName && current && current !== wantedName) {
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
  const email = opts.email;
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
  if (CFG.botQuotaMb > 0) {
    try {
      await immichJson(`/admin/users/${user.id}`, {
        ...jsonBody({ quotaSizeInBytes: CFG.botQuotaMb * 1024 * 1024 }),
        method: 'PUT',
      });
    } catch (e) {
      log(`could not set utility quota for ${email}: ${e.message}`);
    }
  }
  c = {
    ...(c || {}),
    userId: user.id,
    apiKey: keyRes.secret,
    viaPeer: peerPub ?? c?.viaPeer,
    peerUserId: peerUserId ?? c?.peerUserId,
    homePeer: opts.homePeer ?? c?.homePeer,
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
export async function syncAvatar(c, peer, originUserId) {
  if (!peer || !originUserId || c.avatarDone) return;
  try {
    const av = await peerByteRequest(peer, `/users/${originUserId}/avatar`);
    if (av.status < 400) {
      const chunks: Buffer[] = [];
      for await (const chunk of recvIterable(av.recv)) chunks.push(chunk);
      const fd = new FormData();
      fd.set(
        'file',
        new Blob([Buffer.concat(chunks)], {
          type: av.headers['content-type'] || 'image/jpeg',
        }),
        'avatar.jpg'
      );
      const put = await fetch(`${CFG.immichUrl}/api/users/profile-image`, {
        method: 'POST',
        headers: { 'x-api-key': c.apiKey },
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
/**
 * The remote person's local account, present in the album so it can own their photos.
 *
 * ONE account per remote person does both jobs: it is what a human picks in Immich's album
 * picker to share with them, and it owns their mirrored photos so attribution survives. Immich
 * forces that overlap — an album owner adding an asset owned by a NON-member is refused with
 * `no_permission` — so the account has to be a member wherever it owns content.
 *
 * Which means album membership alone no longer tells us whether a human invited them. That
 * distinction moves into the `added` ledger, and the order below is the security property:
 *
 *  1. read the album's current members
 *  2. if the account is ALREADY a member, do nothing and record nothing — someone else put them
 *     there, and that someone is a human whose intent we must not overwrite
 *  3. otherwise record the membership as ours FIRST, then add it
 *
 * Recording after the add would leave, on any crash in between, a membership with no record —
 * which reads as human intent and shares the album with a server nobody offered it to. This way
 * the same crash leaves a record with no membership, which merely ignores a real invitation
 * until the human re-adds. Always fail towards under-sharing.
 */
export async function ensureContributor(
  displayName,
  albumId,
  hostKey,
  peer,
  originUserId,
  peerPub?: string,
  opts: { reAddIfMissing?: boolean } = {}
) {
  // Key on the person's id on their OWN server — required, so this is the same account the
  // directory creates rather than a second entry for one human. No `fullName` and no
  // `homePeer`: a ref proves neither what to call them nor where they live.
  if (!originUserId)
    throw new Error(`ref from "${displayName}" carries no contributor id — refusing a name-keyed account`);
  const c = await ensureUtilityUser(displayName, {
    peerPub,
    peerUserId: originUserId,
    stateKey: `${BOT_PREFIX.person}${originUserId}`,
    email: `${BOT_PREFIX.person}${originUserId}@${UTILITY_EMAIL_DOMAIN}`,
  });
  if (!c.apiKey) throw new Error(`contributor "${displayName}" has no API key yet — will retry`);
  await syncAvatar(c, peer, originUserId);

  let alreadyMember = false;
  try {
    const alb = await immichJson(`/albums/${albumId}?withoutAssets=true`, {}, hostKey);
    alreadyMember = (alb.albumUsers || []).some(au => au.user?.id === c.userId);
  } catch {
    // Cannot read the album, so cannot prove the membership is not already a human's. Do not
    // add: a blind add here could later be misread as an invitation. The next cycle retries.
    return c;
  }
  if (!alreadyMember && opts.reAddIfMissing === false) {
    // An invited person who is not a member has been REVOKED. Do not put them back: the human's
    // removal is the authority here, and the withdrawal sweep will retire the mapping shortly.
    log(`"${displayName}" is no longer a member of this album — not re-adding (revoked)`);
    return c;
  }
  if (!alreadyMember) {
    addedRecord(albumId, c.userId); // record BEFORE the add — see the note above
    try {
      await immichJson(
        `/albums/${albumId}/users`,
        { ...jsonBody({ albumUsers: [{ userId: c.userId, role: 'editor' }] }), method: 'PUT' },
        hostKey
      );
    } catch (e) {
      log(`could not add "${displayName}" to the album: ${e.message} — will retry`);
    }
  }
  return c;
}
