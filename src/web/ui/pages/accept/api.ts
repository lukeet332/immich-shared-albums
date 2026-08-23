/** web/ui/pages/accept/api.ts — the accept page's server calls: whoami, join, album fill, deeplink. See ../../../http-router.md. */
const ROUTE_PREFIX = '/immich-shared-albums';

export type Me = { id: string; name: string };

/** Whoever is signed in to THIS Immich, or null. Their session, not ours to invent. */
export const whoami = async (): Promise<Me | null> => {
  try {
    const r = await fetch('/api/users/me', { credentials: 'include' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

export type JoinResult = {
  ok: boolean;
  album?: string;
  albumId?: string;
  photos?: number;
  from?: string;
  permissions?: string;
  error?: string;
  needsAuth?: boolean;
  signInUrl?: string;
  passwordRequired?: boolean;
};

export const join = async (
  invite: { endpointToken: string; key: string },
  forUserId: string,
  password?: string
): Promise<JoinResult> => {
  const r = await fetch(`${ROUTE_PREFIX}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite, forUserId, ...(password ? { password } : {}) }),
  });
  const body = await r.json().catch(() => ({ error: 'failed' }));
  return { ok: r.ok, ...body };
};

export const albumCount = async (albumId: string): Promise<number> => {
  try {
    const r = await fetch(`/api/albums/${albumId}?withoutAssets=true`, { credentials: 'include' });
    const a = await r.json();
    return a.assetCount || 0;
  } catch {
    return 0;
  }
};

/** The Immich app registers `my.immich.app/albums/<id>`; a bare list path opens no album. */
export const deepLink = (albumId: string) =>
  `intent://my.immich.app/albums/${albumId}#Intent;scheme=https;package=app.alextran.immich;` +
  `S.browser_fallback_url=${encodeURIComponent(`https://my.immich.app/albums/${albumId}`)};end`;
