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

export type Reunion = { albumId: string; name: string };

/**
 * Does this household already own an album of this name? Asked BEFORE joining, because a plain join
 * would leave the person with two albums of one name — the duplicate reunification exists to remove.
 */
export const preview = async (albumName: string): Promise<{ albumName?: string; reunion?: Reunion }> => {
  try {
    const r = await fetch(`${ROUTE_PREFIX}/join/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumName }),
    });
    return r.ok ? await r.json() : {};
  } catch {
    return {}; // a preview is an offer, not a step: failing it must not block the join
  }
};

export const join = async (
  invite: { endpointToken: string; key: string },
  forUserId: string,
  password?: string,
  /** Reunify instead of creating a mirror: the album id is a REQUEST, re-derived against the
   *  caller's own albums server-side before anything is adopted. */
  adoptAlbumId?: string
): Promise<JoinResult> => {
  const r = await fetch(`${ROUTE_PREFIX}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invite,
      forUserId,
      ...(password ? { password } : {}),
      ...(adoptAlbumId ? { adopt: { albumId: adoptAlbumId } } : {}),
    }),
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
