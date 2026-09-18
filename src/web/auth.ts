/**
 * web/auth.ts — who is calling a human-facing sidecar route.
 *
 * The sidecar has no accounts of its own and must never invent any: the only identity
 * that means anything here is an Immich one. So we forward whatever credentials the
 * caller already has — the session cookie a browser holds after signing in, or an API
 * key — to Immich's own /users/me and let Immich answer. That makes these routes exactly
 * as reachable as the Immich they sit next to: safe to publish, because being on the
 * network is not being signed in.
 *
 * This mirrors what media/interceptor.ts already does for byte requests, and replaces the
 * accept page's client-side whoami, which the server previously trusted on faith.
 */
import { CFG } from '../config.ts';
import { credsFromHeaders, type Creds } from '../immich/access.ts';

export type Caller = { id: string; name: string; isAdmin: boolean };
/** A signed-in caller and the credential that proved it. Per-user surfaces must read Immich AS
 *  this caller — filtering someone else's read for them is how a panel ends up empty. */
export type SignedIn = { caller: Caller; creds: Creds };

/** The caller's forwarded credential, or null when they sent none. */
export const callerCreds = (req): Creds | null => credsFromHeaders(req.headers);

/** Resolve the caller against Immich, or null if they are not signed in. */
export async function callerSignedIn(req): Promise<SignedIn | null> {
  const creds = callerCreds(req);
  if (!creds) return null;
  try {
    const r = await fetch(`${CFG.immichUrl}/api/users/me`, {
      headers: { ...creds.headers, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { caller: { id: u.id, name: u.name, isAdmin: !!u.isAdmin }, creds } : null;
  } catch {
    return null;
  }
}

/** Who is calling, when the credential itself is not needed. */
export const callerIdentity = async (req): Promise<Caller | null> =>
  (await callerSignedIn(req))?.caller ?? null;

/** 401 body that tells a browser where to go to fix it. */
export const signInRequired = (what: string) => ({
  error: `sign in to ${CFG.name} to ${what}`,
  signInUrl: '/auth/login',
  needsAuth: true,
});

/** A minimal page for HTML routes reached without a session. */
