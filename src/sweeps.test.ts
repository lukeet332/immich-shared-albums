/** sweeps.test.ts — the rig's hold on the background loops. See sync-loops.md. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSweepsPaused, sweepsArePaused } from './sweeps.ts';

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
