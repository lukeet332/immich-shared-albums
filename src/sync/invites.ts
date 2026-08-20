/**
 * sync/invites.ts — sharing an album by inviting a PERSON in Immich's OWN picker.
 *
 * A share link is how two servers meet; it should not be how every subsequent album is shared.
 * Once a server is linked, this makes the native gesture do the work: every person on the linked
 * server gets a local marker user ("Nan (via The Smiths server)"), and adding one to an album
 * shares that album with that person. Removing them revokes it.
 *
 * Sharing is per person, never household-wide. Linking and unlinking a server is a separate,
 * admin-owned concern and lives in p2p/unlink.ts + the panel — a server link is not a person and
 * should not appear in a people picker pretending to be one.
 *
 * The detection trick is that the marker lists albums with ITS OWN key rather than the admin
 * key. `GET /albums` is scoped per user, so the admin key only ever sees the admin's own albums
 * — which is why a non-admin currently cannot share cross-server at all. Asking as the stand-in
 * sidesteps that completely: it does not matter who owns the album, only that the stand-in was
 * invited to it.
 *
 * Three things Immich does that this code has to allow for:
 *  - the album OWNER appears inside `albumUsers` with `role: 'owner'`, so a stand-in that owns
 *    an album is a mirror we created for inbound content, not an invitation — skip those.
 *  - adding a user who is already the owner returns 200 and is silently ignored, so a 200 is
 *    never proof an invitation took. Read `albumUsers` back instead.
 *  - `GET /albums` returns no `ownerId`; the owner is only discoverable inside `albumUsers`.
 */
import { CFG, log, isUtilityEmail, UTILITY_EMAIL_DOMAIN, BOT_PREFIX, markerName } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, save, store } from '../state.ts';
import { immichJson, jsonBody } from '../immich/client.ts';
import { ensureUtilityUser, slugify } from '../immich/contributors.ts';
import { signedGet } from '../peers.ts';
import { ROUTE_PREFIX } from '../config.ts';
import { ensureMirror, fillMirrorInBackground } from '../p2p/mirror.ts';
import { leaveAlbum } from './leave.ts';
import crypto from 'node:crypto';

/**
 * Our own human users, as offered to a paired household so they can invite one of us
 * specifically. NAMES ONLY — never emails, and never the bot users. Off entirely when
 * SHARE_USER_DIRECTORY=false, which disables native invitations with that peer altogether —
 * sharing is per person, so with no directory there is nobody to name. Share links still work.
 */
export async function localDirectory() {
  if (!CFG.shareUserDirectory) return [];
  const users = await immichJson('/admin/users');
  return (users || [])
    .filter((u) => !isUtilityEmail(u.email) && !u.deletedAt)
    .map((u) => ({ id: u.id, name: u.name }));
}

/**
 * Mirror a peer's directory into local invite-target stand-ins, one per remote person, so they
 * show up in Immich's album picker. Named "Nan (via The Smiths server)" rather than carrying the
 * generic utility suffix — in a picker you are choosing a destination, so the name says where the
 * album is going. See markerName in config.ts for why this must differ from the attribution bot.
 */
async function syncPeerDirectory(peer: Peer) {
  let people;
  try {
    const r = await signedGet(`${peer.url}${ROUTE_PREFIX}/api/v1/directory`, 'directory');
    if (!r.ok) return;                                  // peer too old, or sharing disabled
    people = (await r.json()).users || [];
  } catch { return; }                                    // unreachable: next cycle
  for (const person of people) {
    if (!person?.id || !person?.name) continue;
    try {
      await ensureUtilityUser(person.name, {
        peerPub: peer.pub,
        peerUserId: person.id,
        stateKey: `${BOT_PREFIX.invitePerson}${slugify(peer.name)}-${slugify(person.name)}`,
        email: `${BOT_PREFIX.invitePerson}${slugify(peer.name)}-${slugify(person.name)}@${UTILITY_EMAIL_DOMAIN}`,
        fullName: markerName.person(person.name, peer.name),
      });
    } catch (e) { log(`could not create an invite target for "${person.name}": ${e.message}`); }
  }
}

/** Per-person invite markers for this peer. Never contributors — see BOT_PREFIX. */
function inviteTargetsFor(peerPub: string) {
  return Object.entries(state.contributors || {})
    .filter(([k, c]) => k.startsWith(BOT_PREFIX.invitePerson) && c.peer === peerPub && c.key && c.userId)
    .map(([, c]) => c);
}

/** Immich album roles map onto the permission a share link would have carried. */
export const permissionFor = (role?: string): 'view' | 'contribute' =>
  (role === 'editor' ? 'contribute' : 'view');

/**
 * Sharing is PER PERSON. There is deliberately no household-wide stand-in: a server link is not
 * a person, so it has no business impersonating one in Immich's people picker. Linking and
 * unlinking a server is an admin act and lives in the panel (see p2p/unlink.ts).
 *
 * A per-person marker is only a valid invitation signal because the sidecar NEVER adds it to an
 * album — see BOT_PREFIX. The attribution contributors are the opposite: the sidecar adds those
 * whenever their owner contributes a photo, so their membership means "they contributed here",
 * not "a human invited them". Conflating the two turned every link-shared album into a bogus
 * invitation once (9 offered instead of 1), and later made origin and member ping-pong
 * mirror/withdraw every poll. Read BOT_PREFIX before touching this.
 */

type Invited = { name: string; permissions: 'view' | 'contribute'; ownerName?: string };
type Seen = { invited: Map<string, Invited>; visible: Set<string> };

/** Everything the stand-in can see, split into "invited to" and "merely visible". */
async function albumsAsMarker(markerKey: string, markerUserId: string): Promise<Seen> {
  const albums = await immichJson('/albums', {}, markerKey);
  const invited = new Map<string, Invited>();
  const visible = new Set<string>();
  for (const a of albums || []) {
    visible.add(a.id);
    const mine = (a.albumUsers || []).find((au) => au.user?.id === markerUserId);
    // 'owner' means this is a mirror we created for inbound content, not an invitation
    if (!mine || mine.role === 'owner') continue;
    // v3 album responses carry no ownerId — the owner is only discoverable inside albumUsers
    const owner = (a.albumUsers || []).find((au) => au.role === 'owner');
    invited.set(a.id, { name: a.albumName, permissions: permissionFor(mine.role),
                        ownerName: owner?.user?.name });
  }
  return { invited, visible };
}

/**
 * Origin side: turn native album invitations into mappings, and withdrawn ones into dead
 * mappings. One album list per invited person, asked as that person's marker.
 */
export async function detectInvitesOnce() {
  for (const peer of state.peers) {
    await syncPeerDirectory(peer);

    // One marker per remote person. Union their views, and remember EVERY person invited to a
    // given album: inviting two people from the same household to one album must mirror for both.
    // Abort the peer on ANY read failure — a partial view is indistinguishable from a withdrawal.
    const targets = inviteTargetsFor(peer.pub);
    if (!targets.length) continue;               // directory not shared yet, or SHARE_USER_DIRECTORY=false
    const seen: Seen = { invited: new Map(), visible: new Set() };
    const invitees = new Map<string, Set<string>>();
    let readFailed = false;
    for (const t of targets) {
      try {
        const part = await albumsAsMarker(t.key, t.userId);
        for (const [id, v] of part.invited) {
          if (!seen.invited.has(id)) seen.invited.set(id, v);
          if (t.peerUserId) {
            if (!invitees.has(id)) invitees.set(id, new Set());
            invitees.get(id).add(t.peerUserId);
          }
        }
        for (const id of part.visible) seen.visible.add(id);
      } catch (e) { log(`could not read invitations for "${peer.name}": ${e.message}`); readFailed = true; break; }
    }
    if (readFailed) continue;

    for (const [albumId, a] of seen.invited) {
      const forPeerUserIds = [...(invitees.get(albumId) || [])];
      if (!forPeerUserIds.length) continue;      // invited nobody we can name — nothing to offer
      const existing = state.mappings.find(mp => mp.role === 'owner' && mp.peer === peer.pub && mp.albumId === albumId);
      if (!existing) {
        state.mappings.push({ id: crypto.randomUUID(), role: 'owner', albumId, albumName: a.name,
          peer: peer.pub, permissions: a.permissions, via: 'invite', albumOwnerName: a.ownerName,
          forPeerUserIds });
        save();
        // A silent persistence failure here would mean invitations are re-detected on every
        // restart and withdrawals forgotten, so verify rather than assume.
        const persisted = (store.state.mappings || []).some(x => x.albumId === albumId && x.via === 'invite');
        log(`invited ${forPeerUserIds.length} person(s) at "${peer.name}" to "${a.name}" (${a.permissions}) — shared natively, no link needed`
            + (persisted ? '' : ' [WARNING: mapping did not persist]'));
        continue;
      }
      let changed = false;
      if (existing.dead) { existing.dead = false; changed = true; log(`invitation re-added: "${peer.name}" -> "${a.name}"`); }
      // people added to / removed from the invite while the album stays shared
      const before = (existing.forPeerUserIds || []).slice().sort().join(',');
      if (before !== forPeerUserIds.slice().sort().join(',')) {
        existing.forPeerUserIds = forPeerUserIds; changed = true;
        log(`invitation for "${a.name}" now names ${forPeerUserIds.length} person(s) at "${peer.name}"`);
      }
      if (existing.permissions !== a.permissions) {
        existing.permissions = a.permissions; changed = true;
        log(`invitation for "${peer.name}" on "${a.name}" is now ${a.permissions}`);
      }
      if (changed) save();
    }

    // Withdrawals. ONLY mappings we created from an invitation are eligible: a link-redeemed
    // mapping never had a stand-in added to its album, so it is absent from this list by
    // design and retiring it here would silently unshare every link-based album.
    for (const mp of state.mappings) {
      // OWNER mappings only. This loop judges albums on OUR server by whether the peer's marker
      // is still a member. A member mapping is a mirror we received: the peer's markers were
      // never members of it, so it always looks "withdrawn" here — and retiring it kills a live
      // mirror one poll after the pull created it, which is a mirror/withdraw loop, not a
      // withdrawal. Member mappings are retired by pullInvitationsOnce, against what the peer
      // actually offers.
      if (mp.role !== 'owner') continue;
      if (mp.via !== 'invite' || mp.peer !== peer.pub || mp.dead) continue;
      if (seen.invited.has(mp.albumId)) continue;
      // still visible but not invited => the stand-in owns it, or was demoted oddly; leave it
      if (seen.visible.has(mp.albumId)) continue;
      mp.dead = true; save();
      log(`invitation withdrawn: "${peer.name}" removed from "${mp.albumName}" — no longer syncing it`);
    }
  }
}

/**
 * Wire handler body: what has this peer been invited to? Members POLL this; the origin never
 * pushes, because a member with no inbound reachability still syncs perfectly well by pulling
 * and a push-based invite would fail for exactly those households.
 */
export const invitationsFor = (peerPub: string) =>
  state.mappings
    // ONLY invitation-shaped shares. Offering link-redeemed ones here would re-mirror albums
    // the member already handled through join — and worse, silently undo leaveAlbum on the
    // next poll, because leaving removes the member's mapping but not the origin's.
    .filter((mp: Mapping) => mp.role === 'owner' && mp.via === 'invite' && mp.peer === peerPub && !mp.dead)
    .map((mp: Mapping) => ({
      mappingId: mp.id,
      album: { id: mp.albumId, name: mp.albumName },
      permissions: mp.permissions ?? 'view',
      albumOwner: { displayName: mp.albumOwnerName },
      forUserIds: mp.forPeerUserIds || [],
    }));

/**
 * Make an existing mirror's local membership match who the sender currently names.
 *
 * Adding is the easy half. Removal is the half that matters: dropping one person from an
 * invitation while others remain is a revocation, and without this the de-invited person keeps
 * the album forever — the sender's action would appear to work and quietly do nothing.
 */
async function syncMirrorMembers(mapping: Mapping, forUserIds: string[]) {
  if (!forUserIds.length) return;                 // "nobody named" is handled as a withdrawal
  const host = mapping.adminSlug ? state.contributors[mapping.adminSlug] : undefined;
  if (!host?.key) return;
  let alb;
  try { alb = await immichJson(`/albums/${mapping.albumId}`, {}, host.key); }
  catch { return; }                               // album gone: the withdrawal path will clean up
  const wanted = new Set(forUserIds);
  const current = (alb.albumUsers || []).filter((au) => au.role !== 'owner' && au.user?.id);
  const humans = (await immichJson('/admin/users')).filter((u) => !isUtilityEmail(u.email));
  const localIds = new Set(humans.map((u) => u.id));

  const toAdd = humans.filter((u) => wanted.has(u.id) && !current.some((au) => au.user.id === u.id));
  if (toAdd.length) {
    try {
      await immichJson(`/albums/${mapping.albumId}/users`,
        { ...jsonBody({ albumUsers: toAdd.map((u) => ({ userId: u.id, role: 'editor' })) }), method: 'PUT' }, host.key);
      log(`invitation for "${mapping.albumName}" now includes ${toAdd.length} more of us`);
    } catch (e) { log(`could not widen mirror "${mapping.albumName}": ${e.message}`); }
  }
  // Only ever remove OUR OWN humans. Utility users own the mirror and its stubs; removing one
  // would strand the content it holds.
  for (const au of current) {
    if (!localIds.has(au.user.id) || wanted.has(au.user.id)) continue;
    try {
      await immichJson(`/albums/${mapping.albumId}/user/${au.user.id}`, { method: 'DELETE' }, host.key);
      log(`"${au.user.name}" was dropped from the invitation to "${mapping.albumName}" — removed locally`);
    } catch (e) { log(`could not narrow mirror "${mapping.albumName}": ${e.message}`); }
  }
}

/**
 * Member side: ask each peer what we have been invited to and mirror anything new.
 *
 * PULL, deliberately. A member with no inbound reachability still syncs perfectly well by
 * pulling — proven on the mock rig — so a push-based invitation would fail for exactly the
 * households that most need this (CGNAT, no port forwarding, no reverse proxy).
 */
export async function pullInvitationsOnce() {
  for (const peer of state.peers) {
    let invitations;
    try {
      const r = await signedGet(`${peer.url}${ROUTE_PREFIX}/api/v1/invitations`, 'invitations');
      if (!r.ok) continue;                       // old peer, or not sharing anything with us
      invitations = (await r.json()).invitations || [];
    } catch { continue; }                        // unreachable: try again next cycle

    const offered = new Set<string>();
    for (const inv of invitations) {
      if (inv?.album?.id) offered.add(inv.album.id);
      const albumId = inv?.album?.id;
      if (!albumId) continue;
      // already mirrored, or we are the origin of this album ourselves
      const known = state.mappings.find(mp => mp.peer === peer.pub && !mp.dead
        && (mp.remoteAlbumId === albumId || mp.albumId === albumId));
      if (known) {
        // The sender can add or drop individual people without withdrawing the album. Follow it,
        // or a de-invited person keeps the mirror forever and revocation silently does nothing.
        //
        // Only for mirrors an INVITATION created. A link-redeemed mirror has its own membership
        // (whoever redeemed it, plus anyone who re-joined) and the invitation list is not
        // authoritative over it — narrowing one would evict people who joined by link. A throw
        // here must not abandon the rest of this peer's invitations either.
        if (known.role === 'member' && known.via === 'invite') {
          try { await syncMirrorMembers(known, inv.forUserIds || []); }
          catch (e) { log(`could not follow the invitee list for "${known.albumName}": ${e.message}`); }
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
          // Sharing is per person, so the origin always names who. Never fall back to "everyone
          // here": that would silently widen a share the sender deliberately narrowed.
          forUserIds: inv.forUserIds || [],
        });
        if (created) {
          log(`"${peer.name}" invited ${(inv.forUserIds || []).length} of us to "${inv.album.name}" — mirrored it (${inv.permissions})`);
          fillMirrorInBackground(mapping, peer);
        }
      } catch (e) { log(`could not mirror invitation "${inv.album?.name}": ${e.message}`); }
    }

    // Withdrawn upstream: tear the mirror down rather than leaving a stale album of
    // placeholders that will never resolve. Reached only after a SUCCESSFUL poll (a failed one
    // `continue`s above), and scoped to invitation-created mirrors — a link-based mirror has
    // its own lifecycle via native leave detection and must not be touched here.
    for (const mp of [...state.mappings]) {
      if (mp.role !== 'member' || mp.via !== 'invite' || mp.peer !== peer.pub || mp.dead) continue;
      if (!mp.remoteAlbumId || offered.has(mp.remoteAlbumId)) continue;
      try {
        await leaveAlbum(mp.id);
        log(`"${peer.name}" withdrew "${mp.albumName}" — removed the mirror it created`);
      } catch (e) { log(`could not remove withdrawn mirror "${mp.albumName}": ${e.message}`); }
    }
  }
}

/**
 * Its own loop rather than a step inside watchOnce: engine.ts must not import this module,
 * because p2p/mirror.ts (which this uses) imports engine for the reconciler — that would be a
 * load-time cycle, which ARCHITECTURE.md's third convention forbids. index.ts wires it, which
 * is what a composition root is for.
 */
export let INVITES_RUNNING = false;
export function startInviteLoop() {
  setInterval(() => {
    if (INVITES_RUNNING) return;
    INVITES_RUNNING = true;
    (async () => {
      try { await detectInvitesOnce(); } catch (e) { log(`invite detection error: ${e.message}`); }
      try { await pullInvitationsOnce(); } catch (e) { log(`invitation pull error: ${e.message}`); }
    })().finally(() => { INVITES_RUNNING = false; });
  }, CFG.pollMs);
}
