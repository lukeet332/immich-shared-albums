/** web/ui/pages/me/api.ts — the per-user panel's server surface. Every route is scoped to the
 *  signed-in caller server-side (never trusts a client-supplied user id). See ../../../http-router.md. */
export const ROUTE_PREFIX = '/immich-shared-albums';

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
  /** This household did the adopting, so Un-reunite here will work. A reunified share the PEER
   *  adopted reports false: the undo for an invitation is Immich's own album-sharing settings. */
  adoptedByUs?: boolean;
};

export type MyPage = { albums: MyAlbum[]; household: string; isAdmin: boolean };

export const myAlbums = () => json('/me/albums') as Promise<MyPage>;

/** A pair of same-named albums, one on each server. `mine` is the album this person owns. */
export type PeerMatch = {
  mine: { name: string; assetCount: number };
  theirs: {
    name: string;
    assetCount: number;
    ownerName: string;
    ownerUserId: string;
    startDate?: string;
    endDate?: string;
  };
  peer: string;
  peerName: string;
  sameDates: boolean;
  why: string;
};

/** What this person can do about the pairing — the same four cases the server decides. */
export type ReunionStep =
  { kind: 'invite' } | { kind: 'accept'; mappingId: string } | { kind: 'waiting' } | { kind: 'reunited' };

export type ActionableMatch = PeerMatch & { step: ReunionStep; mappingId?: string };

export const myMatches = () => json('/me/matches') as Promise<{ matches: ActionableMatch[] }>;

/** Ask the person on the other server to reunite this pair: shares my album with them, in Immich. */
export const invite = (peer: string, albumName: string, ownerUserId: string) =>
  json('/me/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peer, albumName, ownerUserId }),
  }) as Promise<{ album: string; invited: string }>;

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

/** This person's own settings. One field today: whether the addon's activity is shown to THEM in
 *  the album's comment history. The route is scoped to the caller server-side, like every other. */
export type Preferences = { auditVisibleInComments: boolean };

export const myPreferences = () => json('/me/preferences') as Promise<Preferences>;

export const savePreferences = (next: Preferences) =>
  json('/me/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  }) as Promise<Preferences>;
