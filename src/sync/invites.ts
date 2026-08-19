/**
 * sync/invites.ts — sharing an album by inviting a household in Immich's OWN picker.
 *
 * A share link is how two households meet; it should not be how every subsequent album is
 * shared. Once a peer is known, this makes the native gesture do the work: each peer gets a
 * local stand-in user ("The Smith household (via shared albums)"), and adding that user to any
 * album shares the album with them. Removing them again revokes it.
 *
 * The detection trick is that the stand-in lists albums with ITS OWN key rather than the admin
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
import { log } from '../config.ts';
import type { Mapping, Peer } from '../store.ts';
import { state, save, store } from '../state.ts';
import { immichJson } from '../immich/client.ts';
import { ensureUtilityUser } from '../immich/contributors.ts';
import { signedGet } from '../peers.ts';
import { ROUTE_PREFIX } from '../config.ts';
import { ensureMirror, fillMirrorInBackground } from '../p2p/mirror.ts';
import crypto from 'node:crypto';

/** Immich album roles map onto the permission a share link would have carried. */
export const permissionFor = (role?: string): 'view' | 'contribute' =>
  (role === 'editor' ? 'contribute' : 'view');

/**
 * The local stand-in for a peer household. Reuses the utility-user machinery, so it is
 * non-admin, holds a narrowly-scoped key and no retained password. It needs `album.read` (part
 * of UTILITY_PERMISSIONS) to enumerate what it has been invited to.
 */
export const ensurePeerMarker = (peer: Peer) => ensureUtilityUser(peer.name);

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
 * mappings. One album list per peer, asked as that peer's stand-in.
 */
export async function detectInvitesOnce() {
  for (const peer of state.peers) {
    let marker;
    try { marker = await ensurePeerMarker(peer); }
    catch (e) { log(`could not provision a stand-in for "${peer.name}": ${e.message}`); continue; }
    if (!marker?.key || !marker.userId) continue;

    let seen: Seen;
    // A failed read must never look like a withdrawal — skip the peer entirely this cycle.
    try { seen = await albumsAsMarker(marker.key, marker.userId); }
    catch (e) { log(`could not read invitations for "${peer.name}": ${e.message}`); continue; }

    for (const [albumId, a] of seen.invited) {
      const existing = state.mappings.find(mp => mp.role === 'owner' && mp.peer === peer.pub && mp.albumId === albumId);
      if (!existing) {
        state.mappings.push({ id: crypto.randomUUID(), role: 'owner', albumId, albumName: a.name,
          peer: peer.pub, permissions: a.permissions, via: 'invite', albumOwnerName: a.ownerName });
        save();
        // A silent persistence failure here would mean invitations are re-detected on every
        // restart and withdrawals forgotten, so verify rather than assume.
        const persisted = (store.state.mappings || []).some(x => x.albumId === albumId && x.via === 'invite');
        log(`invited "${peer.name}" to "${a.name}" (${a.permissions}) — shared natively, no link needed`
            + (persisted ? '' : ' [WARNING: mapping did not persist]'));
        continue;
      }
      let changed = false;
      if (existing.dead) { existing.dead = false; changed = true; log(`invitation re-added: "${peer.name}" -> "${a.name}"`); }
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
    }));

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

    for (const inv of invitations) {
      const albumId = inv?.album?.id;
      if (!albumId) continue;
      // already mirrored, or we are the origin of this album ourselves
      if (state.mappings.some(mp => mp.peer === peer.pub && !mp.dead
        && (mp.remoteAlbumId === albumId || mp.albumId === albumId))) continue;
      try {
        const { mapping, created } = await ensureMirror({
          peer,
          album: { id: albumId, name: inv.album.name },
          permissions: inv.permissions === 'contribute' ? 'contribute' : 'view',
          albumOwnerName: inv.albumOwner?.displayName,
          remoteMappingId: inv.mappingId,
        });
        if (created) {
          log(`"${peer.name}" invited us to "${inv.album.name}" — mirrored it (${inv.permissions})`);
          fillMirrorInBackground(mapping, peer);
        }
      } catch (e) { log(`could not mirror invitation "${inv.album?.name}": ${e.message}`); }
    }
  }
}
