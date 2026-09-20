/** sync/traffic-triggers.ts — what a request through the Immich proxy tells us to do, pure. See sync-loops.md. */

/** What a request means for the work this sidecar does in the background. */
export type TrafficTrigger =
  /** Something the person owns may have changed: read their albums and offer them again. */
  | 'index'
  /** A person arrived (a sign-in, or the session check every client opens with). */
  | 'session'
  /** A comment was written — push it now rather than at the next comment tick. */
  | 'comment';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Which requests are worth acting on — measured, not guessed.
 *
 * A session on Immich is dozens of `/api` calls and the overwhelming majority are the byte path
 * (`/api/assets/…` for every thumbnail on screen), which cannot change an album list or a comment.
 * Acting on all of them would put a credential fingerprint in front of every photo the proxy
 * streams; this costs one string comparison on requests that cannot matter.
 *
 * The three that do say something:
 *  - a WRITE under `/albums` is the index changing, observed rather than inferred — creating,
 *    renaming, deleting, adding or removing assets or people;
 *  - `POST /api/activities` is a comment being written (the app's own route for it), so the push
 *    does not wait out `ISA_COMMENT_POLL_MS`;
 *  - `POST /api/auth/login` and `GET /api/users/me` are a person arriving.
 */
export function trafficTriggerFor(method: string, path: string): TrafficTrigger | undefined {
  const verb = String(method || '').toUpperCase();
  // Anything that WRITES under /albums can change what this person owns. Named as one rule rather
  // than per route, because Immich has grown these over time and a missed one is a silent stale
  // index.
  if (WRITES.has(verb) && (path === '/api/albums' || path.startsWith('/api/albums/'))) return 'index';
  if (verb === 'POST' && path === '/api/activities') return 'comment';
  if (verb === 'POST' && path === '/api/auth/login') return 'session';
  if (verb === 'GET' && path === '/api/users/me') return 'session';
  return undefined;
}
