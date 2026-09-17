/** web/ui/pages/me/api.ts — the per-user panel's server surface. Every route is scoped to the
 *  signed-in caller server-side (never trusts a client-supplied user id). See ../../../http-router.md. */
const ROUTE_PREFIX = '/immich-shared-albums';

const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(ROUTE_PREFIX + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
};

export type MyAlbum = { name: string; role: 'owner' | 'member'; via: string; peer: string };

export const myAlbums = () => json('/me/albums') as Promise<{ albums: MyAlbum[] }>;
