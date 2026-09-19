/**
 * store-published-albums.test.ts — the album index a peer is offered for matching.
 *
 * Two things are load-bearing here, and both are security-shaped rather than cosmetic:
 * what a panel may publish, and which peer may read it back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { albumsOwnedByCaller, type OwnedAlbum } from './sync/matches.ts';
import { parsePublishedAlbums, PUBLISHED_ALBUMS_MAX } from './sync/album-index.ts';

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

/** An album in IMMICH's shape, which is what a panel has in hand: the owner lives inside
 *  albumUsers and there is no top-level ownerUserId field. */
const immichAlbum = (ownerUserId: string, over: Record<string, unknown> = {}) => ({
  id: 'a1',
  albumName: 'Summer 2024',
  assetCount: 3,
  startDate: '2024-06-01T00:00:00.000Z',
  endDate: '2024-08-31T00:00:00.000Z',
  albumUsers: [
    { user: { id: ownerUserId, name: 'Bob' }, role: 'owner' },
    { user: { id: 'u-someone-else', name: 'Someone' }, role: 'editor' },
  ],
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

// The panel posts what the browser read out of Immich. Nothing about that body is trustworthy:
// a caller may only ever publish albums Immich already told them they OWN.
test('the panel may publish only albums the caller owns, never ones merely visible', () => {
  const mine = albumsOwnedByCaller(
    [
      album({ name: 'Mine', ownerUserId: 'u-me' }),
      album({ name: 'Not mine', ownerUserId: 'u-someone-else' }),
    ],
    'u-me'
  );
  assert.deepEqual(
    mine.map(a => a.name),
    ['Mine'],
    `published ${JSON.stringify(mine.map(a => a.name))} — the caller does not own those`
  );
});

test('an entry with no owner at all is refused rather than attributed to the caller', () => {
  const claimed = albumsOwnedByCaller([album({ name: 'No owner', ownerUserId: '' })], 'u-me');
  assert.deepEqual(claimed, [], 'an unowned entry must not be silently adopted by whoever posted it');
});

// The panel posts a JSON body it built from what Immich told it. Parsing is the trust boundary:
// anything malformed is refused outright, and anything claiming another owner is dropped.
test('a malformed publish body is refused rather than partially trusted', () => {
  assert.deepEqual(parsePublishedAlbums('not json at all', 'u-me'), []);
  assert.deepEqual(parsePublishedAlbums('{"albums":{}}', 'u-me'), []);
  assert.deepEqual(parsePublishedAlbums('null', 'u-me'), []);
  assert.deepEqual(parsePublishedAlbums('', 'u-me'), []);
});

test('entries that are not albums are dropped, and the rest survive', () => {
  const body = JSON.stringify({
    albums: [
      null,
      'a string',
      { albumName: 'No owner entry at all' },
      immichAlbum('u-me', { assetCount: 4 }),
    ],
  });
  const parsed = parsePublishedAlbums(body, 'u-me');
  assert.deepEqual(
    parsed.map(a => a.name),
    ['Summer 2024'],
    `parsed ${JSON.stringify(parsed.map(a => a.name))}`
  );
  assert.equal(parsed[0].assetCount, 4);
});

// The panel posts the album list Immich gave it, so the owner is inside albumUsers. A parser that
// only read a top-level ownerUserId would quietly record nothing at all.
test("the body is read in Immich's OWN album shape, owner inside albumUsers", () => {
  const body = JSON.stringify({ albums: [immichAlbum('u-me')] });
  const parsed = parsePublishedAlbums(body, 'u-me');
  assert.deepEqual(
    parsed.map(a => a.name),
    ['Summer 2024']
  );
  assert.equal(parsed[0].ownerUserId, 'u-me', 'the owner must survive the conversion');
});

test('a caller cannot publish an album owned by someone else, whatever the body says', () => {
  const body = JSON.stringify({
    albums: [
      immichAlbum('u-someone-else', { albumName: 'Theirs' }),
      immichAlbum('u-me', { albumName: 'Mine' }),
    ],
  });
  assert.deepEqual(
    parsePublishedAlbums(body, 'u-me').map(a => a.name),
    ['Mine']
  );
});

test('the published count is bounded, so one body cannot fill the index', () => {
  const albums = Array.from({ length: PUBLISHED_ALBUMS_MAX + 50 }, (_, i) =>
    immichAlbum('u-me', { id: `a${i}`, albumName: `Album ${i}` })
  );
  assert.equal(parsePublishedAlbums(JSON.stringify({ albums }), 'u-me').length, PUBLISHED_ALBUMS_MAX);
});

test('a missing or unreadable count is recorded as zero rather than NaN', () => {
  const body = JSON.stringify({ albums: [immichAlbum('u-me', { assetCount: 'lots' })] });
  const [only] = parsePublishedAlbums(body, 'u-me');
  assert.equal(only.assetCount, 0, 'a NaN would sort against nothing and nobody would notice');
});
