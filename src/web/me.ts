/**
 * web/me.ts — data for the per-user panel (/me), ALWAYS scoped to the calling user.
 *
 * The user panel is the keystone surface for the reunification/repair feature. Everything here is
 * filtered to `callerId` server-side — the caller id comes from callerIdentity (their Immich
 * session/key), never from the request, so one user can never see another's data.
 */
import { state } from '../state.ts';
import { getAlbum } from '../immich/client.ts';

export type MyAlbum = { name: string; role: 'owner' | 'member'; via: string; peer: string };

/** The caller's shared albums: cross-server mappings whose Immich album the caller belongs to.
 *  A mapping the caller is not a member of is skipped — never leaked. */
export async function myAlbums(callerId: string): Promise<MyAlbum[]> {
  const out: MyAlbum[] = [];
  for (const m of state.mappings) {
    if (m.dead) continue;
    let album;
    try {
      album = await getAlbum(m.albumId);
    } catch {
      continue; // album gone or unreadable — skip, fail closed
    }
    if (!(album.albumUsers || []).some(au => au.user?.id === callerId)) continue;
    const peer = state.peers.find(p => p.pub === m.peer)?.name || 'a linked server';
    out.push({ name: m.albumName, role: m.role, via: m.via, peer });
  }
  return out;
}
