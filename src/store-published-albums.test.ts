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

test('a published album is readable back for its owner', () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'u-bob', [album()]);
    const back = store.publishedAlbumsFor('peer-1');
    assert.equal(back.length, 1);
    assert.equal(back[0].name, 'Summer 2024');
    assert.equal(back[0].ownerUserId, 'u-bob');
    assert.equal(back[0].startDate, '2024-06-01T00:00:00.000Z');
  });
});

test("republishing replaces that owner's index instead of accumulating it", () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'u-bob', [album(), album({ name: 'Winter 2019' })]);
    store.publishedAlbumsSet('peer-1', 'u-bob', [album({ name: 'Summer 2024', assetCount: 9 })]);
    const back = store.publishedAlbumsFor('peer-1');
    assert.deepEqual(
      back.map(a => a.name),
      ['Summer 2024'],
      `an album deleted on its owner's server must stop being offered: ${JSON.stringify(back.map(a => a.name))}`
    );
    assert.equal(back[0].assetCount, 9, 'the count should be the republished one');
  });
});

test("one peer never sees another peer's index", () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'u-bob', [album({ name: 'Bob album' })]);
    store.publishedAlbumsSet('peer-2', 'u-carol', [album({ name: 'Carol album', ownerUserId: 'u-carol' })]);
    assert.deepEqual(
      store.publishedAlbumsFor('peer-2').map(a => a.name),
      ['Carol album']
    );
    assert.deepEqual(
      store.publishedAlbumsFor('peer-1').map(a => a.name),
      ['Bob album']
    );
    assert.deepEqual(store.publishedAlbumsFor('peer-unknown'), []);
  });
});

test('several owners on one peer all publish, each replaceable on its own', () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'u-bob', [album({ name: 'Bob album' })]);
    store.publishedAlbumsSet('peer-1', 'u-carol', [album({ name: 'Carol album', ownerUserId: 'u-carol' })]);
    assert.deepEqual(
      store
        .publishedAlbumsFor('peer-1')
        .map(a => a.name)
        .sort(),
      ['Bob album', 'Carol album']
    );
    store.publishedAlbumsSet('peer-1', 'u-bob', []);
    assert.deepEqual(
      store.publishedAlbumsFor('peer-1').map(a => a.name),
      ['Carol album']
    );
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
