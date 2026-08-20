/**
 * p2p/unlink.ts — cutting a server link, from the admin panel.
 *
 * Linking two servers is an admin act, so undoing it is too, and it belongs here rather than
 * being expressed by removing a fake "household" user from an album. That was the old shape and
 * it was dishonest twice over: a server link is not a person, and it left revocation depending on
 * a bot's album membership.
 *
 * What unlinking does, and deliberately does not do:
 *  - mirrors we hold from that peer are torn down via leaveAlbum, which purges their stubs too,
 *    so no album of dead placeholders is left behind;
 *  - albums we shared TO them lose their mapping and their entitlement, so we stop serving bytes;
 *  - their per-person invite markers are deleted, so they vanish from Immich's album picker;
 *  - this peer's people are deleted, and their photos go with them. Everything those accounts
 *    own is a proxy whose bytes stream from the peer on demand, so once the link is gone the
 *    assets are unreachable — keeping them would only scatter broken thumbnails through albums
 *    here. Deleting the accounts also takes their album memberships, which is what stops a later
 *    re-link from misreading a leftover membership as a fresh invitation.
 */
import { CFG, log, BOT_PREFIX } from '../config.ts';
import { state, save } from '../state.ts';
import { immichJson } from '../immich/client.ts';
import { forgetOffered } from './entitlement.ts';
import { leaveAlbum } from '../sync/leave.ts';

export type UnlinkResult = {
  household: string;
  mirrorsRemoved: number;
  sharesRevoked: number;
  markersRemoved: number;
};

export async function unlinkPeer(pub: string): Promise<UnlinkResult> {
  const peer = state.peers.find(p => p.pub === pub);
  if (!peer) throw new Error('unknown household');
  const household = peer.name;
  let mirrorsRemoved = 0,
    sharesRevoked = 0,
    markersRemoved = 0;

  // Copy first: leaveAlbum splices state.mappings, so iterating it live would skip entries.
  for (const mp of [...state.mappings].filter(m => m.peer === pub)) {
    if (mp.role === 'member') {
      try {
        await leaveAlbum(mp.id);
        mirrorsRemoved++;
      } catch (e) {
        log(`unlink: could not remove mirror "${mp.albumName}": ${e.message}`);
      }
      continue;
    }
    forgetOffered(mp.id);
    const at = state.mappings.findIndex(x => x.id === mp.id);
    if (at >= 0) {
      state.mappings.splice(at, 1);
      sharesRevoked++;
    }
  }

  // Delete this peer's people, and their photos go with them.
  //
  // Everything these accounts own is a PROXY: a stub whose real bytes stream from the peer on
  // demand. Once the link is gone those bytes are unreachable, so keeping the assets would leave
  // broken thumbnails scattered through albums here. `force: true` removes the user and its
  // assets together, which is also what `leaveAlbum` already does for a mirror's stubs.
  //
  // Deleting them takes their album memberships with them, which is what closes the re-link
  // hole: nothing is left behind for a future directory sync to misread as a fresh invitation.
  for (const [slug, c] of Object.entries(state.contributors || {})) {
    if (!slug.startsWith(BOT_PREFIX.person) || (c.homePeer ?? c.peer) !== pub) continue;
    if (c.userId) {
      try {
        await immichJson(`/admin/users/${c.userId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
        markersRemoved++;
      } catch (e) {
        // Left behind: keep the state entry so a re-link reuses it rather than minting a twin.
        log(`unlink: could not delete ${slug}: ${e.message} — leaving it in place`);
        continue;
      }
    }
    delete state.contributors[slug];
  }

  const pi = state.peers.findIndex(p => p.pub === pub);
  if (pi >= 0) state.peers.splice(pi, 1);
  save();
  log(
    `unlinked "${household}" — ${mirrorsRemoved} mirror(s) removed, ${sharesRevoked} share(s) revoked, ${markersRemoved} account(s) removed with their proxied photos`
  );
  return { household, mirrorsRemoved, sharesRevoked, markersRemoved };
}

/** What the panel shows: one row per linked server, with what the link is currently carrying. */
export const linkedPeers = () =>
  state.peers.map(p => ({
    pub: p.pub,
    name: p.name,
    url: p.url,
    version: p.version,
    sharedToThem: state.mappings.filter(m => m.peer === p.pub && m.role === 'owner' && !m.dead).length,
    sharedToUs: state.mappings.filter(m => m.peer === p.pub && m.role === 'member' && !m.dead).length,
    people: Object.entries(state.contributors || {}).filter(
      ([k, c]) => k.startsWith(BOT_PREFIX.person) && c.peer === p.pub
    ).length,
  }));

/** Our own household identity, for the panel header. */
export const localHousehold = () => ({ name: CFG.name, url: CFG.publicUrl });
