/**
 * sync/pass.ts — run one pass of every loop, on demand.
 *
 * The events say when work finished; this makes it happen now. Without it a caller waiting on an
 * event for timer-driven work (comment sync, invitation poll) is still waiting for a tick, just
 * with a better notification at the end of it. The timers are unchanged — this is in addition.
 *
 * Reachable only through the test hooks (`ISA_TEST_HOOKS`), which are off by default.
 */
import { state } from '../state.ts';
import { watchOnce } from './engine.ts';
import { detectInvitesOnce, pullInvitationsOnce } from './invites.ts';
import { syncComments } from './comments.ts';
import { syncStatus } from './status.ts';
import type { SyncStatus } from '../types.ts';

/** A mapping's status, named, so a caller can see which one is outstanding. */
export type MappingStatus = SyncStatus & { id: string; name: string; role: string };

export const allStatus = (): MappingStatus[] =>
  state.mappings.map(m => ({ id: m.id, name: m.albumName, role: m.role, ...syncStatus(m) }));

export const allSettled = (statuses: MappingStatus[]): boolean => statuses.every(s => s.settled);

/** One pass of every loop, in the order the timers run them, awaited to completion.
 *
 *  `watchOnce` already ends by calling `reconcileOnce`, so the pull half happens inside it; the
 *  comment and invitation loops are separate and run explicitly, because a caller waiting on a
 *  comment or an invitation would otherwise still be waiting for their timers. */
export async function runSyncPass(): Promise<void> {
  await watchOnce().catch(() => false);
  await detectInvitesOnce().catch(() => undefined);
  await pullInvitationsOnce().catch(() => undefined);
  await syncComments().catch(() => undefined);
}
