/**
 * sync/status.ts — whether a mapping has finished its work, answered rather than guessed.
 *
 * Every wait in this system used to be a timeout because the sidecar had no way to say "I'm done":
 * the cursors are only written after a CLEAN pass, which is exactly the information a caller needs
 * and exactly what was never exposed. A mapping is settled when the watcher recorded the album's
 * current version (nothing left to push) and the reconciler recorded the peer's (nothing left to
 * pull). Both cursors are already persisted and already load-bearing — this only reads them.
 */
import type { Mapping } from '../store.ts';
import type { SyncStatus } from '../types.ts';

/** Watcher cycles completed per mapping since boot. In memory on purpose: it is a progress
 *  indicator for callers waiting on convergence, not a fact worth a schema migration. */
const cycles = new Map<string, number>();

export const recordWatcherCycle = (mappingId: string) =>
  cycles.set(mappingId, (cycles.get(mappingId) || 0) + 1);
export const forgetWatcherCycles = (mappingId: string) => cycles.delete(mappingId);

/** Loop evaluations since boot, counted at the TOP of each tick — before the untouched-album skip,
 *  before any early return. `cycles` above counts passes that did work and therefore stops
 *  advancing the moment a mapping settles; a caller asking "has the sidecar looked N more times
 *  and left things alone?" needs this count instead. Process-wide, in memory, observational. */
export type LoopName = 'watcher' | 'invites';
const ticks: Record<LoopName, number> = { watcher: 0, invites: 0 };
export const recordLoopTick = (loop: LoopName) => {
  ticks[loop] += 1;
};
export const loopTicks = (): Record<LoopName, number> => ({ ...ticks });

/** Nudges RECEIVED since boot, by kind. A nudge and a sweep produce the same end state, so a test
 *  that only looks at the state cannot tell which one did the work — this is what makes "the nudge
 *  did it" an assertion instead of a hope. Observational, in memory, like the tick counts. */
export type NudgeKind = 'album' | 'index' | 'invitations';
const nudges: Record<NudgeKind, number> = { album: 0, index: 0, invitations: 0 };
export const recordNudge = (kind: NudgeKind) => {
  nudges[kind] += 1;
};
export const nudgesReceived = (): Record<NudgeKind, number> => ({ ...nudges });

/** `album` is the local album as read this cycle: its `updatedAt` is what a settled
 *  `localVersion` must equal. Omit it to answer from state alone (a status probe off the sync
 *  path), where an absent cursor counts as not settled rather than optimistically settled. */
export function syncStatus(mapping: Mapping, album?: { updatedAt?: string }): SyncStatus {
  const dead = !!mapping.dead;
  const failCount = mapping.failCount || 0;
  // Deferred refs are invisible in the ledger by design — they are the ones NOT recorded. What is
  // visible is that localVersion never advanced to the album's current version, because that
  // write only happens when a pass had nothing left to defer.
  const pushed = !!album?.updatedAt && mapping.localVersion === album.updatedAt;
  const settled = !dead && failCount === 0 && (album ? pushed : !!mapping.localVersion);
  return { settled, pending: 0, cycles: cycles.get(mapping.id) || 0, failCount, dead };
}

/** Human-readable one-liner for logs: why a mapping is not settled. */
export const whyNotSettled = (status: SyncStatus): string =>
  status.dead ? 'retired' : status.failCount ? `${status.failCount} failed cycles` : 'refs deferred';
