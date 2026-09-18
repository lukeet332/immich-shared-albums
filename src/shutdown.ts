/** shutdown.ts — exiting on the signal a container runtime sends. See ARCHITECTURE.md. */

/** How long to let in-flight requests finish before exiting anyway. Nothing is persisted or
 *  drained on the way out — the loops are all restartable — so this is a courtesy, not a budget. */
export const FORCE_EXIT_MS = 3000;

/** Stop listening and exit. Separated from the signal registration so a test can drive it without
 *  a real process, and so the exit path has exactly one definition. */
export const stopListening = (server: { close: (cb: () => void) => unknown }): void => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), FORCE_EXIT_MS).unref();
};

/** Node is PID 1 in the image (exec-form CMD, no init), and the kernel ignores a signal a PID-1
 *  process has no handler for — so without this a `docker stop` waits out its entire grace period
 *  and SIGKILLs us. That is a slow restart for an operator and dead wall clock in every e2e run
 *  that restarts a sidecar. Registering the handler is the whole fix; it must never be replaced. */
export const exitOnTerminationSignals = (
  server: { close: (cb: () => void) => unknown },
  log: (...a: unknown[]) => void
): void => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`received ${signal} — closing the listener and exiting`);
      stopListening(server);
    });
  }
};
