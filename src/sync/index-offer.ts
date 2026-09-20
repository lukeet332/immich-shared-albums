/** sync/index-offer.ts — when a person's albums are worth offering to a peer again. See sync-loops.md. */

import type { OwnedAlbum } from './matches.ts';

/**
 * How long one refresh stands for.
 *
 * A person's album list cannot change without them using Immich, and using Immich through this
 * sidecar is what starts the next session — so the first request after this much quiet is the
 * moment the list may have moved, and the rest of that session costs nothing. Measured from the
 * last request, not the last refresh: a session that keeps talking never re-reads.
 */
export const SESSION_QUIET_MS = 15 * 60 * 1000;

/** Whether a request at `now` opens a session for this credential. */
export const opensSession = (lastVisitAt: number, now: number) => now - lastVisitAt >= SESSION_QUIET_MS;

/**
 * Did what this person offers change?
 *
 * Compared on the fields matching reads, because those fields ARE the match: a rename, a new photo
 * or a new album all change what a peer can pair with, and a peer told "look again" pays a dial.
 * Order is not a change.
 */
export function indexChanged(before: OwnedAlbum[], after: OwnedAlbum[]): boolean {
  const key = (a: OwnedAlbum) =>
    `${a.name}\u0000${a.assetCount}\u0000${a.startDate ?? ''}\u0000${a.endDate ?? ''}\u0000${a.ownerName}`;
  if (before.length !== after.length) return true;
  const was = new Set(before.map(key));
  return after.some(a => !was.has(key(a)));
}

/**
 * The window between refreshes, and how it stretches.
 *
 * Reading a person's album list costs one call whose PAYLOAD grows with their library (~620 bytes an
 * album, measured): a fixed one-minute cadence on a 500-album library is ~18 MB/hour of JSON per
 * active person, while a fifteen-minute one is ~1 MB/hour. Neither is right for everyone, so the
 * window follows the evidence instead of a clock: every refresh that finds NOTHING doubles the wait,
 * up to the cap, and any refresh that finds a change drops it straight back to the base. Someone
 * building an album gets minute-by-minute discovery; someone who has not touched their library in
 * months costs four reads an hour.
 */
export const OFFER_BASE_MS = 60 * 1000;
export const OFFER_MAX_MS = 15 * 60 * 1000;

/** The window after this many consecutive refreshes that found nothing. */
export const offerWindowMs = (refreshesWithNoChange: number): number =>
  Math.min(OFFER_BASE_MS * 2 ** refreshesWithNoChange, OFFER_MAX_MS);

/** Whether a request at `now` should read this person's albums again. */
export function shouldRefresh(
  visit: { lastVisitAt: number; lastRefreshAt: number; refreshesWithNoChange: number },
  now: number
): boolean {
  if (opensSession(visit.lastVisitAt, now)) return true;
  return now - visit.lastRefreshAt >= offerWindowMs(visit.refreshesWithNoChange);
}
