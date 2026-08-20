/** The panel's whole server surface. Every route here is admin-only. */
const ROUTE_PREFIX = '/immich-shared-albums';

const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(ROUTE_PREFIX + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
};

const post = (path: string, body?: unknown) =>
  json(path, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

export type Peer = {
  pub: string;
  name: string;
  url: string;
  version?: string;
  people: number;
  sharedToThem: number;
  sharedToUs: number;
};
export type Album = { name: string; role: string; via: string; peer: string };
export type Overview = { household: { name: string; url: string }; peers: Peer[]; albums: Album[] };

export const overview = () => json('/peers') as Promise<Overview>;
export const mintLink = () => post('/pairings') as Promise<{ link: string; expiresAt: number }>;
export const redeemLink = (link: string) => post('/pair', { link }) as Promise<{ linked: string }>;
export const unlinkPeer = (pub: string) => post('/unlink', { pub }) as Promise<{ household: string }>;
