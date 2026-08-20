/** web/accept/api.ts — the joining page's server calls. See ../http-router.md. */
const ROUTE_PREFIX = '/immich-shared-albums';

export type Me = { id: string; name: string };

export const whoami = async (): Promise<Me | null> => {
  try {
    const response = await fetch('/api/users/me', { credentials: 'include' });
    return response.ok ? await response.json() : null;
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

export const join = async (url: string, forUserId: string, password?: string): Promise<JoinResult> => {
  const response = await fetch(`${ROUTE_PREFIX}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, forUserId, ...(password ? { password } : {}) }),
  });
  const body = await response.json().catch(() => ({ error: 'failed' }));
  return { ok: response.ok, ...body };
};

export const albumCount = async (albumId: string): Promise<number> => {
  try {
    const response = await fetch(`/api/albums/${albumId}?withoutAssets=true`, { credentials: 'include' });
    const album = await response.json();
    return album.assetCount || 0;
  } catch {
    return 0;
  }
};

/** The Immich app registers `my.immich.app/albums/<id>`; a bare list path opens no album. */
export const deepLink = (albumId: string) =>
  `intent://my.immich.app/albums/${albumId}#Intent;scheme=https;package=app.alextran.immich;` +
  `S.browser_fallback_url=${encodeURIComponent(`https://my.immich.app/albums/${albumId}`)};end`;
