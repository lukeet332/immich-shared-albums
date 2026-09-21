/** immich/shape.test.ts — the displayed shape of a photo, and whether Immich has measured it. See sync-loops.md. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayDims, shapeIsKnown } from './shape.ts';

test('a landscape photo keeps its dimensions', () => {
  assert.deepEqual(displayDims({ exifImageWidth: 4000, exifImageHeight: 3000 }), {
    width: 4000,
    height: 3000,
  });
});

test('a quarter-turn orientation is swapped to what Immich actually renders', () => {
  // Orientations 5–8 are the 90°/270° family: Immich renders them rotated, so the stub must match
  // the rendered shape or every portrait photo lays out landscape in the grid.
  assert.deepEqual(displayDims({ exifImageWidth: 4000, exifImageHeight: 3000, orientation: '6' }), {
    width: 3000,
    height: 4000,
  });
});

test('an orientation that is not a quarter turn is left alone', () => {
  assert.deepEqual(displayDims({ exifImageWidth: 4000, exifImageHeight: 3000, orientation: '1' }), {
    width: 4000,
    height: 3000,
  });
});

test('dimensions Immich has not measured yet are unknown, not zero', () => {
  // The whole point: {} means "hold this photo back", not "a 0x0 photo" — the caller must be able to
  // tell a photo waiting on Immich's metadata job from one that is genuinely shapeless.
  for (const exif of [
    undefined,
    {},
    { exifImageWidth: null, exifImageHeight: null },
    { exifImageWidth: 0, exifImageHeight: 0 },
    { exifImageWidth: 'x', exifImageHeight: 5 },
  ]) {
    assert.deepEqual(displayDims(exif), {}, JSON.stringify(exif));
    assert.equal(shapeIsKnown(exif), false, JSON.stringify(exif));
  }
});

test('one known side is not a shape', () => {
  assert.equal(shapeIsKnown({ exifImageWidth: 4000 }), false);
  assert.equal(shapeIsKnown({ exifImageHeight: 3000 }), false);
});

test('a measurable photo is a known shape', () => {
  assert.equal(shapeIsKnown({ exifImageWidth: 1, exifImageHeight: 1 }), true);
});
