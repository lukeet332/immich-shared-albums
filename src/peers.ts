/** peers.ts — peer lookups and the fire-and-forget nudge, on the iroh transport. See peers.md. */
import { state, save } from './state.ts';
import { peerRequest } from './p2p/transport.ts';
import type { Peer } from './store.ts';

export const peerByPub = (pub: string): Peer | undefined => state.peers.find(p => p.pub === pub);

/**
 * Find one of THIS peer's mappings. The `m.peer === peerPub` term is the whole point:
 * without it a mapping id alone selects an album, and any enrolled peer can act on a
 * relationship that belongs to a different household.
 */
/**
 * Ask every linked peer who it is, protocol-wise, and remember the answer. Once per boot:
 * capabilities change on upgrade, and upgrades restart the process. A peer that 404s the
 * route is a protocol-2 build from before /hello existed — remembered as exactly that.
 */
export async function helloPeers() {
  for (const peer of state.peers) {
    try {
      const r = await peerRequest(peer, '/hello');
      if (r.status < 400 && typeof r.json?.protocol === 'number') {
        peer.protocol = r.json.protocol;
        peer.features = Array.isArray(r.json.features) ? r.json.features : [];
        if (typeof r.json.version === 'string') peer.version = r.json.version;
      } else if (r.status === 404) {
        peer.protocol = 2;
        peer.features = [];
      }
      save();
    } catch {
      /* unreachable — next boot retries */
    }
  }
}

export function mappingFor(peerPub: string, ref: string, role?: 'owner' | 'member') {
  return state.mappings.find(
    m =>
      m.peer === peerPub &&
      (!role || m.role === role) &&
      (m.id === ref || m.albumId === ref || m.remoteAlbumId === ref)
  );
}

// Nudge: tell every OTHER household mapped to this album that it moved, so they pull
// now instead of at their next tick. Fire-and-forget — a lost nudge costs nothing,
// the scheduled handshake still catches everything (fail-open by design).
export function nudgePeers(albumId: string, exceptPeerPub?: string) {
  for (const mp of state.mappings) {
    if (mp.albumId !== albumId || mp.dead || mp.role !== 'owner' || mp.peer === exceptPeerPub) continue;
    const peer = peerByPub(mp.peer);
    if (!peer) continue;
    peerRequest(peer, `/albums/${albumId}/nudge`, { album: albumId }).catch(() => {
      /* fail-open */
    });
  }
}
