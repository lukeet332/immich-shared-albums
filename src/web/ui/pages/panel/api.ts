/** web/ui/pages/panel/api.ts — The panel's whole server surface. Every route here is admin-only. See ../../../http-router.md. */
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
  version?: string;
  people: number;
  sharedToThem: number;
  sharedToUs: number;
};
export type Album = { name: string; role: string; via: string; peer: string };
export type Overview = { household: { name: string }; peers: Peer[]; albums: Album[] };

export const overview = () => json('/peers') as Promise<Overview>;
export const mintLink = () => post('/pairings') as Promise<{ link: string; expiresAt: number }>;
export const redeemLink = (link: string) => post('/pair', { link }) as Promise<{ linked: string }>;
export const unlinkPeer = (pub: string) => post('/unlink', { pub }) as Promise<{ household: string }>;
export type Settings = {
  shareLinkJoin: boolean;
  pairingTtlMinutes: number;
  storeSharedAssetsLocally: boolean;
};
export const getSettings = () => json('/settings') as Promise<Settings>;
export const saveSettings = (next: Settings) => post('/settings', next) as Promise<Settings>;
