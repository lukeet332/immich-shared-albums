/** sweeps.ts — the state of the background loops: held still, or working. See sync-loops.md. */

let paused = false;
const working = new Set<string>();

/** How long a hold waits for work already in flight. A cycle that is still running when the hold is
 *  acknowledged can deliver a change after it, which is the one thing the hold exists to rule out. */
export const SWEEP_DRAIN_MS = 15_000;
const DRAIN_POLL_MS = 50;

/** Whether the loops are held still. Only the LOOP SCHEDULERS read this: a nudge handler runs its own
 *  pull regardless, which is what makes "it arrived with the sweeps held" a claim about the nudge. */
export const sweepsArePaused = () => paused;

/** Hold or release them — rig-only, and set back by whatever held them. Holding does not stop work
 *  already in flight; `whenSweepsIdle` is how a caller waits that out. */
export const setSweepsPaused = (value: boolean) => {
  paused = value;
};

/** Claim a sweep's slot, or false when it is already running — the overlap guard, in the same place
 *  as the hold, so "what the sweeps are doing" has one answer rather than one per loop. */
export function startSweep(name: string): boolean {
  if (working.has(name)) return false;
  working.add(name);
  return true;
}

/** Release it. Safe to call for a sweep that never started. */
export const finishSweep = (name: string) => {
  working.delete(name);
};

/** True when nothing is mid-cycle. */
export const sweepsAreIdle = () => working.size === 0;

/** Wait, bounded, for the sweeps in flight to finish. Answers whether they are idle now. */
export async function whenSweepsIdle(budgetMs: number = SWEEP_DRAIN_MS): Promise<boolean> {
  for (const deadline = Date.now() + budgetMs; Date.now() < deadline;) {
    if (sweepsAreIdle()) return true;
    await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
  }
  return sweepsAreIdle();
}
