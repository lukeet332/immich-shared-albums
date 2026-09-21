/** sweeps.ts — the rig's hold on the background loops that retry what a nudge missed. See sync-loops.md. */

let paused = false;

/** Whether the background loops are held still. Only the LOOP SCHEDULERS read this: a nudge handler
 *  runs its own pull regardless, which is what makes "it arrived with the sweeps held" a claim about
 *  the nudge. */
export const sweepsArePaused = () => paused;

/** Hold or release them — rig-only, and set back by whatever held them. */
export const setSweepsPaused = (value: boolean) => {
  paused = value;
};
