/** p2p/unlink.ts — cutting a server link, from the admin panel. See wire-protocol.md. */
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
    const mappingIndex = state.mappings.findIndex(x => x.id === mp.id);
    if (mappingIndex >= 0) {
      state.mappings.splice(mappingIndex, 1);
      sharesRevoked++;
    }
  }

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
        log(`unlink: could not delete ${slug}: ${e.message} — leaving it in place`);
        continue;
      }
    }
    delete state.contributors[slug];
  }

  const peerIndex = state.peers.findIndex(p => p.pub === pub);
  if (peerIndex >= 0) state.peers.splice(peerIndex, 1);
  save();
  log(
    `unlinked "${household}" — ${mirrorsRemoved} mirror(s) removed, ${sharesRevoked} share(s) revoked, ${markersRemoved} account(s) removed with their proxied photos`
  );
  return { household, mirrorsRemoved, sharesRevoked, markersRemoved };
}

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

export const sharedAlbums = () =>
  state.mappings
    .filter(m => !m.dead)
    .map(m => ({
      name: m.albumName,
      role: m.role,
      via: m.via ?? 'link',
      peer: state.peers.find(p => p.pub === m.peer)?.name ?? '',
    }));

export const localHousehold = () => ({ name: CFG.name, url: CFG.publicUrl });
