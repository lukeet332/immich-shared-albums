/** sweeps.test.ts — the state of the background loops: held, running, idle. See sync-loops.md. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  finishSweep,
  setSweepsPaused,
  startSweep,
  sweepsAreIdle,
  sweepsArePaused,
  whenSweepsIdle,
} from './sweeps.ts';

test('the sweeps run unless a rig has held them', () => {
  assert.equal(sweepsArePaused(), false);
});

test('holding and releasing is one switch, and releasing is what a lane must do before it ends', () => {
  setSweepsPaused(true);
  assert.equal(sweepsArePaused(), true);
  setSweepsPaused(false);
  assert.equal(sweepsArePaused(), false);
});

test('holding twice is still one hold — nothing has to count releases', () => {
  setSweepsPaused(true);
  setSweepsPaused(true);
  setSweepsPaused(false);
  assert.equal(sweepsArePaused(), false);
});

test('a running sweep holds its slot, which is also the overlap guard', () => {
  assert.equal(startSweep('watch'), true);
  assert.equal(startSweep('watch'), false, 'a second cycle must not stack on the first');
  assert.equal(sweepsAreIdle(), false);
  finishSweep('watch');
  assert.equal(sweepsAreIdle(), true);
});

test('another loop starting does not free the first one’s slot', () => {
  startSweep('watch');
  startSweep('invites');
  finishSweep('invites');
  assert.equal(sweepsAreIdle(), false, 'the watcher is still working');
  finishSweep('watch');
  assert.equal(sweepsAreIdle(), true);
});

test('waiting for idle sees a sweep finish mid-wait', async () => {
  startSweep('watch');
  const drained = whenSweepsIdle(2000);
  setTimeout(() => finishSweep('watch'), 60);
  assert.equal(await drained, true);
});

test('waiting for idle gives up rather than hanging on a sweep that will not finish', async () => {
  startSweep('stuck');
  assert.equal(await whenSweepsIdle(120), false);
  finishSweep('stuck');
});
