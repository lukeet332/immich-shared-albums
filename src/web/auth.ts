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

export type Caller = { id: string; name: string; isAdmin: boolean };

const CRED_HEADERS = ['cookie', 'x-api-key', 'authorization'] as const;

/** Resolve the caller against Immich, or null if they are not signed in. */
export async function callerIdentity(req): Promise<Caller | null> {
  const headers: Record<string, string> = {};
  for (const h of CRED_HEADERS) if (req.headers[h]) headers[h] = req.headers[h] as string;
  if (!Object.keys(headers).length) return null;
  try {
    const r = await fetch(`${CFG.immichUrl}/api/users/me`, {
      headers: { ...headers, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, name: u.name, isAdmin: !!u.isAdmin } : null;
  } catch {
    return null;
  }
}

/** 401 body that tells a browser where to go to fix it. */
export const signInRequired = (what: string) => ({
  error: `sign in to ${CFG.name} to ${what}`,
  signInUrl: '/auth/login',
  needsAuth: true,
});

/** A minimal page for HTML routes reached without a session. */
