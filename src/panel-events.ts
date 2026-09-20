/** panel-events.ts — the hint channel to panels that are open. See web/http-router.md. */

import { log } from './config.ts';

/**
 * A panel's open connection, and the events that make it re-read.
 *
 * The panels fetch once when they mount: a row whose state changed on the server — an invitation
 * that arrived, a peer index that moved, a reunion that completed — could only be seen by
 * reloading the page. This is the missing half of the nudge: peers already tell US instantly, and
 * this tells the BROWSER.
 *
 * The event carries a type and nothing else, which is the same rule the wire nudges follow: a
 * subscriber reacts by re-reading its own caller-scoped data, so a hint can never become a source,
 * and a panel can never be shown something it is not allowed to read for itself.
 */
export type PanelEventType = 'invitations' | 'index' | 'shares';

type Subscriber = (type: PanelEventType) => void;
const subscribers = new Set<Subscriber>();
let hintsEmitted = 0;

/** How many hints this process has emitted. Observability only — an open panel must not be able to
 *  make the server hint at it in a loop, and a count is the only way to see that from outside. */
export const panelHintsEmitted = () => hintsEmitted;

/** How many panels are listening. Observability only — the e2e rig asserts a panel is connected
 *  before it changes anything, so a passing test cannot be one that had nobody to notify. */
export const panelSubscribers = () => subscribers.size;

/** Listen until the returned function is called. */
export function subscribeToPanelEvents(listener: Subscriber): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** Tell every open panel that something it displays may have changed. */
export function emitPanelEvent(type: PanelEventType): void {
  hintsEmitted++;
  if (subscribers.size === 0) return;
  log(`panel hint "${type}" → ${subscribers.size} watching`);
  for (const listener of subscribers) {
    try {
      listener(type);
    } catch {
      /* a closed socket is not the emitter's problem */
    }
  }
}
