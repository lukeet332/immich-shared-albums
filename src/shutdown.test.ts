/**
 * shutdown.test.ts — the sidecar must exit promptly on the signal a container runtime sends.
 *
 * The bug this guards: Node is PID 1 in the image, so a SIGTERM with no handler is ignored by the
 * kernel and `docker stop` waits out its whole grace period before SIGKILL. It cost every e2e run
 * that restarts a sidecar, and a refactor dropping the registration would restore it silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitOnTerminationSignals, stopListening, FORCE_EXIT_MS } from './shutdown.ts';

test('every termination signal closes the listener and exits', () => {
  const registered = new Map<string, () => void>();
  const original = process.on;
  // Capture instead of registering, so the real process does not get handlers from a test.
  process.on = ((signal: string, listener: () => void) => {
    registered.set(signal, listener);
    return process;
  }) as typeof process.on;
  try {
    exitOnTerminationSignals({ close: () => {} }, () => {});
  } finally {
    process.on = original;
  }

  assert.deepEqual([...registered.keys()].sort(), ['SIGINT', 'SIGTERM']);
});

test('the handler stops listening, and exits when close reports done', () => {
  const exits: number[] = [];
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  try {
    let closed = false;
    stopListening({
      close: cb => {
        closed = true;
        cb();
      },
    });
    assert.equal(closed, true, 'close must actually be called');
    assert.deepEqual(exits, [0], 'must exit 0 once close reports back');
  } finally {
    process.exit = originalExit;
  }
});

test('a hung close still exits, so the container is never left waiting', t => {
  // A server with an open keep-alive or SSE connection can leave close() pending forever. If that
  // were the only exit path, the container would sit until the runtime SIGKILLed it — the same
  // slow stop this module exists to remove, just moved. Driven on mock timers so the test asserts
  // the force-exit actually fires rather than that a constant has a sensible value.
  const exits: number[] = [];
  const originalExit = process.exit;
  // Throwing is what lets the assertion run: the real process.exit never returns, so a test that
  // called it directly would simply end the runner.
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new Error('process.exit called');
  }) as typeof process.exit;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tickPastForceExit = () => {
    try {
      t.mock.timers.tick(FORCE_EXIT_MS);
    } catch (e) {
      if ((e as Error).message !== 'process.exit called') throw e;
    }
  };
  try {
    stopListening({ close: () => {} }); // never calls back — a stuck listener
    assert.deepEqual(exits, [], 'must NOT exit before the force timer is due');
    tickPastForceExit();
    assert.deepEqual(exits, [0], 'the force timer must exit 0 rather than wait on close()');
  } finally {
    process.exit = originalExit;
    t.mock.timers.reset();
  }
});
