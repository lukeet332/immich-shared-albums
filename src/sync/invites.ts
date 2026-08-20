/** sync/invites.ts — sharing an album by inviting a PERSON in Immich's own picker. See invites.md. */
import { CFG, log, isUtilityEmail, UTILITY_EMAIL_DOMAIN, BOT_PREFIX, markerName } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, save, store, addedHas, addedForget } from '../state.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { ensureLocalAccountFor } from '../immich/contributors.ts';
import { signedGet } from '../peers.ts';
import { ROUTE_PREFIX } from '../config.ts';
import { ensureMirror, fillMirrorInBackground } from '../p2p/mirror.ts';
import { leaveAlbum } from './leave.ts';
import { diffInvitees } from './invitees.ts';
import crypto from 'node:crypto';

/** NAMES ONLY — never emails. See invites.md. */
export async function localDirectory() {
  if (!CFG.shareUserDirectory) return [];
  const users = await immichJson('/admin/users');
  return (users || [])
    .filter(u => !isUtilityEmail(u.email) && !u.deletedAt)
    .map(u => ({ id: u.id, name: u.name }));
}

async function mirrorPeerDirectoryIntoLocalAccounts(peer: Peer) {
  let people;
  try {
    const response = await signedGet(`${peer.url}${ROUTE_PREFIX}/api/v1/directory`, 'directory');
    if (!response.ok) return; // peer too old, or sharing disabled
    people = (await response.json()).users || [];
  } catch {
    return;
  } // unreachable: next cycle
  for (const person of people) {
    if (!person?.id || !person?.name) continue;
    try {
      await ensureLocalAccountFor(person.name, {
        peerPub: peer.pub,
        peerUserId: person.id,
        stateKey: `${BOT_PREFIX.person}${person.id}`,
        email: `${BOT_PREFIX.person}${person.id}@${UTILITY_EMAIL_DOMAIN}`,
        fullName: markerName.person(person.name, peer.name),
        homePeer: peer.pub,
      });
    } catch (e) {
      log(`could not create an invite target for "${person.name}": ${e.message}`);
    }
  }
}

function invitablePeopleAt(peerPub: string) {
  return Object.values(state.contributors || {}).filter(c => c.homePeer === peerPub && c.key && c.userId);
}

export const permissionFor = (role?: string): 'view' | 'contribute' =>
  role === 'editor' ? 'contribute' : 'view';

type Invited = { name: string; permissions: 'view' | 'contribute'; ownerName?: string };
type Seen = { invited: Map<string, Invited>; visible: Set<string> };

async function albumsVisibleTo(markerKey: string, markerUserId: string): Promise<Seen> {
  const albums = await immichJson('/albums', {}, markerKey);
  const invited = new Map<string, Invited>();
  const visible = new Set<string>();
  for (const a of albums || []) {
    visible.add(a.id);
    const mine = (a.albumUsers || []).find(au => au.user?.id === markerUserId);
    if (!mine || mine.role === 'owner') {
      addedForget(a.id, markerUserId);
      continue;
    }
    if (addedHas(a.id, markerUserId)) continue;
    const owner = (a.albumUsers || []).find(au => au.role === 'owner');
    invited.set(a.id, {
      name: a.albumName,
      permissions: permissionFor(mine.role),
      ownerName: owner?.user?.name,
    });
  }
  return { invited, visible };
}

export async function detectInvitesOnce() {
  for (const peer of state.peers) {
    await mirrorPeerDirectoryIntoLocalAccounts(peer);

    const targets = invitablePeopleAt(peer.pub);
    if (!targets.length) continue; // directory not shared yet, or SHARE_USER_DIRECTORY=false
    const seen: Seen = { invited: new Map(), visible: new Set() };
    const invitees = new Map<string, Set<string>>();
    let readFailed = false;
    for (const t of targets) {
      try {
        const part = await albumsVisibleTo(t.key, t.userId);
        for (const [id, v] of part.invited) {
          if (!seen.invited.has(id)) seen.invited.set(id, v);
          if (t.peerUserId) {
            let people = invitees.get(id);
            if (!people) invitees.set(id, (people = new Set()));
            people.add(t.peerUserId);
          }
        }
        for (const id of part.visible) seen.visible.add(id);
      } catch (e) {
        log(`could not read invitations for "${peer.name}": ${e.message}`);
        readFailed = true;
        break;
      }
    }
    if (readFailed) continue;

    for (const [albumId, a] of seen.invited) {
      const forPeerUserIds = [...(invitees.get(albumId) || [])];
      if (!forPeerUserIds.length) continue; // invited nobody we can name — nothing to offer
      const existing = state.mappings.find(
        mp => mp.role === 'owner' && mp.peer === peer.pub && mp.albumId === albumId
      );
      if (!existing) {
        state.mappings.push({
          id: crypto.randomUUID(),
          role: 'owner',
          albumId,
          albumName: a.name,
          peer: peer.pub,
          permissions: a.permissions,
          via: 'invite',
          albumOwnerName: a.ownerName,
          forPeerUserIds,
        });
        save();
        const persisted = (store.state.mappings || []).some(x => x.albumId === albumId && x.via === 'invite');
        log(
          `invited ${forPeerUserIds.length} person(s) at "${peer.name}" to "${a.name}" (${a.permissions}) — shared natively, no link needed` +
            (persisted ? '' : ' [WARNING: mapping did not persist]')
        );
        continue;
      }
      let changed = false;
      if (existing.dead) {
        existing.dead = false;
        changed = true;
        log(`invitation re-added: "${peer.name}" -> "${a.name}"`);
      }
      const before = (existing.forPeerUserIds || []).slice().sort().join(',');
      if (before !== forPeerUserIds.slice().sort().join(',')) {
        existing.forPeerUserIds = forPeerUserIds;
        changed = true;
        log(`invitation for "${a.name}" now names ${forPeerUserIds.length} person(s) at "${peer.name}"`);
      }
      if (existing.permissions !== a.permissions) {
        existing.permissions = a.permissions;
        changed = true;
        log(`invitation for "${peer.name}" on "${a.name}" is now ${a.permissions}`);
      }
      if (changed) save();
    }

    for (const mp of state.mappings) {
      if (mp.role !== 'owner') continue;
      if (mp.via !== 'invite' || mp.peer !== peer.pub || mp.dead) continue;
      if (seen.invited.has(mp.albumId)) continue;
      if (seen.visible.has(mp.albumId)) continue;
      mp.dead = true;
      save();
      log(`invitation withdrawn: "${peer.name}" removed from "${mp.albumName}" — no longer syncing it`);
      // Remove ONLY memberships in the `added` ledger — never a human's. invites.md.
      for (const t of targets) {
        if (!addedHas(mp.albumId, t.userId)) continue;
        try {
          await immichJson(`/albums/${mp.albumId}/user/${t.userId}`, { method: 'DELETE' });
          addedForget(mp.albumId, t.userId);
          log(`  removed our own attribution membership from "${mp.albumName}"`);
        } catch (e) {
          log(`  could not tidy our membership on "${mp.albumName}": ${e.message}`);
        }
      }
    }
  }
}

export const invitationsFor = (peerPub: string) =>
  state.mappings
    .filter((mp: Mapping) => mp.role === 'owner' && mp.via === 'invite' && mp.peer === peerPub && !mp.dead)
    .map((mp: Mapping) => ({
      mappingId: mp.id,
      album: { id: mp.albumId, name: mp.albumName },
      permissions: mp.permissions ?? 'view',
      albumOwner: { displayName: mp.albumOwnerName },
      forUserIds: mp.forPeerUserIds || [],
    }));

async function syncMirrorMembers(mapping: Mapping, forUserIds: string[]) {
  const host = mapping.adminSlug ? state.contributors[mapping.adminSlug] : undefined;
  if (!host?.key) return;
  let alb;
  try {
    alb = await immichJson(`/albums/${mapping.albumId}`, {}, host.key);
  } catch {
    return;
  } // album gone: the withdrawal path will clean up
  const humans = (await immichJson('/admin/users')).filter(u => !isUtilityEmail(u.email));
  const { add, remove } = diffInvitees({
    wanted: forUserIds,
    current: (alb.albumUsers || []).filter(au => au.role !== 'owner' && au.user?.id).map(au => au.user.id),
    local: humans.map(u => u.id),
  });
  if (add.length) {
    try {
      await immichJson(
        `/albums/${mapping.albumId}/users`,
        { ...jsonBody({ albumUsers: add.map(id => ({ userId: id, role: 'editor' })) }), method: 'PUT' },
        host.key
      );
      log(`invitation for "${mapping.albumName}" now includes ${add.length} more of us`);
    } catch (e) {
      log(`could not widen mirror "${mapping.albumName}": ${e.message}`);
    }
  }
  for (const id of remove) {
    try {
      await immichJson(`/albums/${mapping.albumId}/user/${id}`, { method: 'DELETE' }, host.key);
      log(
        `"${humans.find(u => u.id === id)?.name || id}" was dropped from the invitation to "${mapping.albumName}" — removed locally`
      );
    } catch (e) {
      log(`could not narrow mirror "${mapping.albumName}": ${e.message}`);
    }
  }
}

export async function pullInvitationsOnce() {
  for (const peer of state.peers) {
    let invitations;
    try {
      const response = await signedGet(`${peer.url}${ROUTE_PREFIX}/api/v1/invitations`, 'invitations');
      if (!response.ok) continue; // old peer, or not sharing anything with us
      invitations = (await response.json()).invitations || [];
    } catch {
      continue;
    } // unreachable: try again next cycle

    const offered = new Set<string>();
    for (const inv of invitations) {
      if (inv?.album?.id) offered.add(inv.album.id);
      const albumId = inv?.album?.id;
      if (!albumId) continue;
      const known = state.mappings.find(
        mp => mp.peer === peer.pub && !mp.dead && (mp.remoteAlbumId === albumId || mp.albumId === albumId)
      );
      if (known) {
        if (known.role === 'member' && known.via === 'invite') {
          try {
            await syncMirrorMembers(known, inv.forUserIds || []);
          } catch (e) {
            log(`could not follow the invitee list for "${known.albumName}": ${e.message}`);
          }
        }
        continue;
      }
      try {
        const { mapping, created } = await ensureMirror({
          peer,
          album: { id: albumId, name: inv.album.name },
          permissions: inv.permissions === 'contribute' ? 'contribute' : 'view',
          albumOwnerName: inv.albumOwner?.displayName,
          remoteMappingId: inv.mappingId,
          via: 'invite',
          forUserIds: inv.forUserIds || [],
        });
        if (created) {
          log(
            `"${peer.name}" invited ${(inv.forUserIds || []).length} of us to "${inv.album.name}" — mirrored it (${inv.permissions})`
          );
          fillMirrorInBackground(mapping, peer);
        }
      } catch (e) {
        log(`could not mirror invitation "${inv.album?.name}": ${e.message}`);
      }
    }

    for (const mp of [...state.mappings]) {
      if (mp.role !== 'member' || mp.via !== 'invite' || mp.peer !== peer.pub || mp.dead) continue;
      if (!mp.remoteAlbumId || offered.has(mp.remoteAlbumId)) continue;
      try {
        await leaveAlbum(mp.id);
        log(`"${peer.name}" withdrew "${mp.albumName}" — removed the mirror it created`);
      } catch (e) {
        log(`could not remove withdrawn mirror "${mp.albumName}": ${e.message}`);
      }
    }
  }
}

export let INVITES_RUNNING = false;
export function startInviteLoop() {
  setInterval(() => {
    if (INVITES_RUNNING) return;
    INVITES_RUNNING = true;
    void (async () => {
      try {
        await detectInvitesOnce();
      } catch (e) {
        log(`invite detection error: ${e.message}`);
      }
      try {
        await pullInvitationsOnce();
      } catch (e) {
        log(`invitation pull error: ${e.message}`);
      }
    })().finally(() => {
      INVITES_RUNNING = false;
    });
  }, CFG.pollMs);
}
