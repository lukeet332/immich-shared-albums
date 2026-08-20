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
 *  - attribution contributors are KEPT. They own real photos that local people can see (relayed
 *    contributions land in albums we own), and deleting the user deletes that content. An
 *    unlink must not be a data-loss event, so these are left for the operator to remove.
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
  let mirrorsRemoved = 0, sharesRevoked = 0, markersRemoved = 0;

  // Copy first: leaveAlbum splices state.mappings, so iterating it live would skip entries.
  for (const mp of [...state.mappings].filter(m => m.peer === pub)) {
    if (mp.role === 'member') {
      try { await leaveAlbum(mp.id); mirrorsRemoved++; }
      catch (e) { log(`unlink: could not remove mirror "${mp.albumName}": ${e.message}`); }
      continue;
    }
    forgetOffered(mp.id);
    const at = state.mappings.findIndex(x => x.id === mp.id);
    if (at >= 0) { state.mappings.splice(at, 1); sharesRevoked++; }
  }

  // Their invite markers exist only so our people could pick them. Once unlinked they are noise
  // in every picker, so remove them — they own nothing, which is what makes this safe.
  for (const [slug, c] of Object.entries(state.contributors || {})) {
    if (!slug.startsWith(BOT_PREFIX.invitePerson) || c.peer !== pub) continue;
    if (c.userId) {
      try {
        await immichJson(`/admin/users/${c.userId}`,
          { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true }) });
        markersRemoved++;
      } catch (e) { log(`unlink: could not delete marker ${slug}: ${e.message}`); }
    }
    delete state.contributors[slug];
  }

  const pi = state.peers.findIndex(p => p.pub === pub);
  if (pi >= 0) state.peers.splice(pi, 1);
  save();
  log(`unlinked "${household}" — ${mirrorsRemoved} mirror(s) removed, ${sharesRevoked} share(s) revoked, ${markersRemoved} marker(s) deleted`);
  return { household, mirrorsRemoved, sharesRevoked, markersRemoved };
}

/** What the panel shows: one row per linked server, with what the link is currently carrying. */
export const linkedPeers = () => state.peers.map(p => ({
  pub: p.pub,
  name: p.name,
  url: p.url,
  version: p.version,
  sharedToThem: state.mappings.filter(m => m.peer === p.pub && m.role === 'owner' && !m.dead).length,
  sharedToUs: state.mappings.filter(m => m.peer === p.pub && m.role === 'member' && !m.dead).length,
  people: Object.entries(state.contributors || {})
    .filter(([k, c]) => k.startsWith(BOT_PREFIX.invitePerson) && c.peer === p.pub).length,
}));

/** Our own household identity, for the panel header. */
export const localHousehold = () => ({ name: CFG.name, url: CFG.publicUrl });
