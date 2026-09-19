/** store-published-albums.test.ts — the album index a peer is offered for matching, and the store that holds it. See docs/post-v1-reunification-design.md §4. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { parseRequestedPeer, type OwnedAlbum } from './sync/matches.ts';

const withStore = (fn: (store: Store) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-published-'));
  const store = new Store(dir);
  try {
    fn(store);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** A flat album, as the index stores and serves it. */
const album = (over: Partial<OwnedAlbum> = {}): OwnedAlbum => ({
  name: 'Summer 2024',
  assetCount: 3,
  startDate: '2024-06-01T00:00:00.000Z',
  endDate: '2024-08-31T00:00:00.000Z',
  ownerUserId: 'u-bob',
  ownerName: 'Bob',
  ...over,
});

// Named fixtures, and assertions that read THROUGH them: a literal in both the fixture and the
// assertion asserts nothing about the store, and stops meaning the same thing the moment the
// fixture is edited.
const bobAlbum = album({ name: 'Bob album' });
const carolAlbum = album({ name: 'Carol album', ownerUserId: 'u-carol', ownerName: 'Carol' });
const republishedBobAlbum = album({ name: bobAlbum.name, assetCount: 9 });

/** What the store yields for an album it holds, so an assertion can compare a fixture to it.
 *
 *  Two differences from the fixture, both real and neither interesting to each test: `node:sqlite`
 *  returns null-PROTOTYPE objects, and SQLite has no `undefined`, so an absent date comes back as
 *  NULL. Naming both here is what stops every assertion restating them. */
const asStored = (a: OwnedAlbum): OwnedAlbum =>
  Object.assign(Object.create(null), {
    ...a,
    startDate: a.startDate ?? null,
    endDate: a.endDate ?? null,
  }) as OwnedAlbum;

test('a published album is readable back for its owner', () => {
  withStore(store => {
    const [only] = [bobAlbum];
    store.publishedAlbumsSet('peer-1', only.ownerUserId, [only]);
    const back = store.publishedAlbumsFor('peer-1');
    assert.deepEqual(back, [asStored(only)], 'what went in must come back out unchanged');
  });
});

test("republishing replaces that owner's index instead of accumulating it", () => {
  withStore(store => {
    const withdrawn = album({ name: 'Winter 2019' });
    store.publishedAlbumsSet('peer-1', withdrawn.ownerUserId, [bobAlbum, withdrawn]);
    store.publishedAlbumsSet('peer-1', republishedBobAlbum.ownerUserId, [republishedBobAlbum]);
    const back = store.publishedAlbumsFor('peer-1');
    assert.deepEqual(
      back,
      [asStored(republishedBobAlbum)],
      `an album deleted on its owner's server must stop being offered: ${JSON.stringify(back)}`
    );
  });
});

test("one peer never sees another peer's index", () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', bobAlbum.ownerUserId, [bobAlbum]);
    store.publishedAlbumsSet('peer-2', carolAlbum.ownerUserId, [carolAlbum]);
    assert.deepEqual(store.publishedAlbumsFor('peer-2'), [asStored(carolAlbum)]);
    assert.deepEqual(store.publishedAlbumsFor('peer-1'), [asStored(bobAlbum)]);
    assert.deepEqual(store.publishedAlbumsFor('peer-unknown'), []);
  });
});

test('several owners on one peer all publish, each replaceable on its own', () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', bobAlbum.ownerUserId, [bobAlbum]);
    store.publishedAlbumsSet('peer-1', carolAlbum.ownerUserId, [carolAlbum]);
    const both = store.publishedAlbumsFor('peer-1');
    assert.deepEqual(
      both.map(a => a.name).sort(),
      [bobAlbum.name, carolAlbum.name].sort(),
      'both owners on one peer are offered, sorted by name for a stable comparison'
    );
    // Clearing ONE owner's index must leave the other owner's alone.
    store.publishedAlbumsSet('peer-1', bobAlbum.ownerUserId, []);
    assert.deepEqual(store.publishedAlbumsFor('peer-1'), [asStored(carolAlbum)]);
  });
});

// The publish body names a peer and nothing else: the albums come from Immich on the caller's own
// credential, so there is no album list here to validate or distrust.
test('a publish names the peer it is addressed to, and nothing else is read from it', () => {
  assert.equal(parseRequestedPeer(JSON.stringify({ peer: 'pub-1', albums: [{ name: 'ignored' }] })), 'pub-1');
  assert.equal(parseRequestedPeer('{"peer":"pub-1"}'), 'pub-1');
});

test('a body that does not name a peer is refused rather than addressed to nobody', () => {
  assert.equal(parseRequestedPeer('not json'), null);
  assert.equal(parseRequestedPeer(''), null);
  assert.equal(parseRequestedPeer('null'), null);
  assert.equal(parseRequestedPeer('"a string"'), null);
  assert.equal(parseRequestedPeer('[]'), null);
  assert.equal(parseRequestedPeer('{}'), null);
  assert.equal(parseRequestedPeer('{"peer":""}'), null);
  assert.equal(parseRequestedPeer('{"peer":123}'), null);
  assert.equal(parseRequestedPeer('{"peer":null}'), null);
});
