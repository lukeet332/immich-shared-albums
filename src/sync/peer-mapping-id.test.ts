/** sync/peer-mapping-id.test.ts — the id a peer addresses the album behind a mapping by. See sync-loops.md. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { peerAlbumMappingId } from './peer-mapping-id.ts';

test('a member mirror is addressed by the id the ORIGIN gave it', () => {
  assert.equal(
    peerAlbumMappingId({
      role: 'member',
      albumId: 'ours',
      remoteMappingId: 'theirs',
      remoteAlbumId: 'their-album',
    }),
    'theirs'
  );
});

test('a member mirror with no mapping id falls back to the origin album id', () => {
  // Protocol-2 mirrors predate remoteMappingId; the origin still answers its own album id.
  assert.equal(
    peerAlbumMappingId({ role: 'member', albumId: 'ours', remoteAlbumId: 'their-album' }),
    'their-album'
  );
});

test('our OWN album is addressed by our album id, never by the mirror we hold of it', () => {
  // The trap this exists for: an owner mapping carries remote ids too (the mirror the peer made of
  // OUR album), and pushing our own photos to one of those would send them to a mapping that is not
  // ours to write — the peer's mirror id names an album on the PEER's side.
  assert.equal(
    peerAlbumMappingId({
      role: 'owner',
      albumId: 'ours',
      remoteMappingId: 'theirs',
      remoteAlbumId: 'their-album',
    }),
    'ours'
  );
});

test('a member mapping with nothing remote is empty, so a caller can refuse rather than guess', () => {
  assert.equal(peerAlbumMappingId({ role: 'member', albumId: 'ours' }), '');
});
