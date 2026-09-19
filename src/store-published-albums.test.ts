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
    store.publishedAlbumsSet('peer-1', 'to-them', only.ownerUserId, [only]);
    const back = store.publishedAlbumsFor('peer-1', 'to-them');
    assert.deepEqual(back, [asStored(only)], 'what went in must come back out unchanged');
  });
});

test("republishing replaces that owner's index instead of accumulating it", () => {
  withStore(store => {
    const withdrawn = album({ name: 'Winter 2019' });
    store.publishedAlbumsSet('peer-1', 'to-them', withdrawn.ownerUserId, [bobAlbum, withdrawn]);
    store.publishedAlbumsSet('peer-1', 'to-them', republishedBobAlbum.ownerUserId, [republishedBobAlbum]);
    const back = store.publishedAlbumsFor('peer-1', 'to-them');
    assert.deepEqual(
      back,
      [asStored(republishedBobAlbum)],
      `an album deleted on its owner's server must stop being offered: ${JSON.stringify(back)}`
    );
  });
});

// The per-owner replace above cannot cover this one: it is called FOR an owner, so an owner the
// peer no longer mentions is never called at all and their rows are never removed. A peer answers
// `/albums` with its whole index, which makes silence about an owner an ANSWER rather than an
// absence of news — and `handlePublishedAlbums` says so: "a peer that has published nothing gets an
// empty list".
test('a peer that withdraws everything stops being matched against', () => {
  withStore(store => {
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', [bobAlbum, carolAlbum]);
    assert.equal(store.publishedAlbumsFor('peer-1', 'from-them').length, 2, 'sanity: both owners went in');
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', []);
    assert.deepEqual(
      store.publishedAlbumsFor('peer-1', 'from-them'),
      [],
      'an empty index is an ANSWER: the peer offers nothing, so nothing may be matched against'
    );
  });
});

test('a peer-wide replace drops an owner who withdrew, and keeps the rest', () => {
  withStore(store => {
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', [bobAlbum, carolAlbum]);
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', [bobAlbum]); // carol took hers back
    const back = store.publishedAlbumsFor('peer-1', 'from-them');
    assert.deepEqual(
      back,
      [asStored(bobAlbum)],
      `carol's albums must be gone while bob's stay: ${JSON.stringify(back)}`
    );
  });
});

// THE BUG THIS PINS: both directions were keyed by peer alone, so one peer's rows held what this
// server OFFERS them and what it RECEIVED from them together. A refresh from the peer replaced the
// lot, wiping the offer — and the peer, asking for our index, was handed its own albums back.
test('offering and receiving are separate rows for the same peer', () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'to-them', bobAlbum.ownerUserId, [bobAlbum]);
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', [carolAlbum]);
    assert.deepEqual(
      store.publishedAlbumsFor('peer-1', 'to-them'),
      [asStored(bobAlbum)],
      'what we offer must survive a refresh from the same peer'
    );
    assert.deepEqual(
      store.publishedAlbumsFor('peer-1', 'from-them'),
      [asStored(carolAlbum)],
      'and what we received must not be served back as an offer'
    );
  });
});

test('a peer withdrawing everything clears only what we received', () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'to-them', bobAlbum.ownerUserId, [bobAlbum]);
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', [carolAlbum]);
    store.publishedAlbumsReplacePeer('peer-1', 'from-them', []);
    assert.deepEqual(store.publishedAlbumsFor('peer-1', 'from-them'), [], 'nothing left to match against');
    assert.deepEqual(
      store.publishedAlbumsFor('peer-1', 'to-them'),
      [asStored(bobAlbum)],
      'while the peer can still find US: withdrawing must not erase what we offer'
    );
  });
});

test("one peer never sees another peer's index", () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'to-them', bobAlbum.ownerUserId, [bobAlbum]);
    store.publishedAlbumsSet('peer-2', 'to-them', carolAlbum.ownerUserId, [carolAlbum]);
    assert.deepEqual(store.publishedAlbumsFor('peer-2', 'to-them'), [asStored(carolAlbum)]);
    assert.deepEqual(store.publishedAlbumsFor('peer-1', 'to-them'), [asStored(bobAlbum)]);
    assert.deepEqual(store.publishedAlbumsFor('peer-unknown', 'to-them'), []);
  });
});

test('several owners on one peer all publish, each replaceable on its own', () => {
  withStore(store => {
    store.publishedAlbumsSet('peer-1', 'to-them', bobAlbum.ownerUserId, [bobAlbum]);
    store.publishedAlbumsSet('peer-1', 'to-them', carolAlbum.ownerUserId, [carolAlbum]);
    const both = store.publishedAlbumsFor('peer-1', 'to-them');
    assert.deepEqual(
      both.map(a => a.name).sort(),
      [bobAlbum.name, carolAlbum.name].sort(),
      'both owners on one peer are offered, sorted by name for a stable comparison'
    );
    // Clearing ONE owner's index must leave the other owner's alone.
    store.publishedAlbumsSet('peer-1', 'to-them', bobAlbum.ownerUserId, []);
    assert.deepEqual(store.publishedAlbumsFor('peer-1', 'to-them'), [asStored(carolAlbum)]);
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
