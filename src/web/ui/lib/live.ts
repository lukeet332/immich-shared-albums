/** web/ui/lib/live.ts — the server's live hint channel, shared by both panels. See ../../../http-router.md. */

/**
 * Follow the server's hints until the returned unsubscribe is called.
 *
 * A message is a HINT and carries nothing: each page re-reads what it shows as its own caller, so a
 * hint can never reveal something the viewer could not fetch. EventSource reconnects on its own, and
 * a sidecar that predates the route answers 404 — the page then behaves exactly as it did before.
 */
export const followServerHints = (routePrefix: string, onHint: () => void) => {
  const events = new EventSource(`${routePrefix}/events`);
  events.onmessage = () => onHint();
  return () => events.close();
};
