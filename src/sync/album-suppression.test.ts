/** album-suppression.test.ts — refusing to materialise a photo the album already holds. See sync-loops.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existingCopyInAlbum, mappingsSharingAlbum } from './album-suppression.ts';

const mapping = (id: string, albumId: string, over: Record<string, unknown> = {}) => ({
  id,
  albumId,
  ...over,
});
const row = (mapping: string, checksum: string, localAsset = 'asset-1') => ({
  mapping,
  checksum,
  localAsset,
  originAsset: 'origin-1',
  storedFull: 0,
});

test('the mappings sharing an album are exactly the ones whose local half is that album', () => {
  const ids = mappingsSharingAlbum('album-1', [mapping('m1', 'album-1'), mapping('m2', 'album-2')]);
  assert.deepEqual(ids, ['m1']);
});

test('a dead mapping is not asked — its rows outlive it, and honouring one suppresses a photo nothing serves', () => {
  const ids = mappingsSharingAlbum('album-1', [mapping('m1', 'album-1', { dead: true })]);
  assert.deepEqual(ids, []);
});

// The case stage 3 exists for: a 3-way mesh offers ONE photo through two shares that land on the
// same album, and each would otherwise materialise its own stub, because the bytes differ by a
// random tail and Immich cannot collapse them.
test('a copy another mapping already put in the same album is found', () => {
  const found = existingCopyInAlbum(
    'album-1',
    'summer.jpg',
    [mapping('m1', 'album-1'), mapping('m2', 'album-1')],
    [row('m1', 'summer.jpg')]
  );
  assert.equal(found?.localAsset, 'asset-1');
});

// The same photo in two DIFFERENT albums is the normal case, not a duplicate: the two sides of a
// reunion each hold their own half, and suppressing across albums would hide a photo that is
// genuinely only in one of them.
test('the same photo in a different album is NOT suppressed', () => {
  const found = existingCopyInAlbum(
    'album-1',
    'summer.jpg',
    [mapping('m1', 'album-2')],
    [row('m1', 'summer.jpg')]
  );
  assert.equal(found, undefined);
});

test('a row whose mapping no longer shares the album is ignored', () => {
  const found = existingCopyInAlbum(
    'album-1',
    'summer.jpg',
    [mapping('m1', 'album-2')],
    [row('m1', 'summer.jpg'), { ...row('gone', 'summer.jpg'), mapping: 'gone' }]
  );
  assert.equal(found, undefined);
});

test('a different checksum is not suppressed', () => {
  const found = existingCopyInAlbum(
    'album-1',
    'winter.jpg',
    [mapping('m1', 'album-1')],
    [row('m1', 'summer.jpg')]
  );
  assert.equal(found, undefined);
});

test('an album holding nothing for that photo suppresses nothing', () => {
  assert.equal(existingCopyInAlbum('album-1', 'summer.jpg', [mapping('m1', 'album-1')], []), undefined);
});
