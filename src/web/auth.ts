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
export const SIGN_IN_PAGE = (what: string) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${CFG.name}</title>
<style>
 body{margin:0;font-family:Inter,-apple-system,sans-serif;background:#101216;color:#e5e7eb;display:grid;place-items:center;min-height:100vh}
 .c{width:min(400px,92vw);background:#1f2229;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:28px;text-align:center}
 h1{font-size:18px;margin:0 0 8px} p{color:#9aa0a6;font-size:14px;line-height:1.55;margin:0 0 20px}
 a{display:inline-block;background:#4250af;color:#fff;text-decoration:none;font-weight:600;padding:11px 26px;border-radius:999px;font-size:14px}
</style>
<div class="c"><h1>Sign in to continue</h1>
<p>You need to be signed in to ${CFG.name} to ${what}.</p>
<a href="/auth/login">Sign in to Immich</a></div>`;
