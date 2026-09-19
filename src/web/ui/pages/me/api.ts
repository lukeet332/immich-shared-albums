/** web/ui/pages/me/api.ts — the per-user panel's server surface. Every route is scoped to the
 *  signed-in caller server-side (never trusts a client-supplied user id). See ../../../http-router.md. */
const ROUTE_PREFIX = '/immich-shared-albums';

const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(ROUTE_PREFIX + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
};

export type MyAlbum = {
  name: string;
  role: 'owner' | 'member';
  via: string;
  peer: string;
  mappingId: string;
  reunified?: boolean;
};

export type MyPage = { albums: MyAlbum[]; household: string; isAdmin: boolean };

export const myAlbums = () => json('/me/albums') as Promise<MyPage>;

/** A pair of same-named albums, one on each server. `mine` is the album this person owns. */
export type PeerMatch = {
  mine: { name: string; assetCount: number };
  theirs: { name: string; assetCount: number; ownerName: string };
  peer: string;
  peerName: string;
  sameDates: boolean;
  why: string;
};

export type ActionableMatch = PeerMatch & { mappingId?: string };

export const myMatches = () => json('/me/matches') as Promise<{ matches: ActionableMatch[] }>;

/** Replace a share with an album I already own. `albumId` is the local album the match showed. */
export const unreunite = (mappingId: string) =>
  json('/me/unreunite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mappingId }),
  }) as Promise<{ left: string; purged: number }>;

export const reunite = (mappingId: string, albumName: string) =>
  json('/me/reunite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mappingId, albumName }),
  }) as Promise<{ album: string; seeded: number }>;
