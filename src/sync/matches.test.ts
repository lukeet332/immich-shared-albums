/** matches.test.ts — the pure half of reunification matching. See matches.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { albumsIPublish, matchAlbums, normaliseAlbumName, type OwnedAlbum } from './matches.ts';

const album = (over: Partial<OwnedAlbum>): OwnedAlbum => ({
  name: 'Summer 2024',
  assetCount: 10,
  startDate: '2024-06-01T00:00:00.000Z',
  endDate: '2024-08-31T00:00:00.000Z',
  ownerUserId: 'u-alice',
  ownerName: 'Alice',
  ...over,
});

// The image response as Immich actually sends it: no ownerId field, the owner only inside albumUsers.
const immichAlbum = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  albumName: 'Summer 2024',
  assetCount: 3,
  startDate: '2024-06-01T00:00:00.000Z',
  endDate: '2024-08-31T00:00:00.000Z',
  albumUsers: [
    { user: { id: 'u-bob', name: 'Bob' }, role: 'owner' },
    { user: { id: 'u-alice', name: 'Alice' }, role: 'editor' },
  ],
  ...over,
});

test('only albums the caller OWNS are published, never ones merely visible', () => {
  const mine = albumsIPublish(
    [
      immichAlbum(),
      immichAlbum({
        id: 'a2',
        albumName: 'Theirs',
        albumUsers: [
          { user: { id: 'u-bob', name: 'Bob' }, role: 'editor' },
          { user: { id: 'u-alice', name: 'Alice' }, role: 'owner' },
        ],
      }),
    ],
    'u-bob'
  );
  assert.deepEqual(
    mine.map(a => a.name),
    ['Summer 2024'],
    `published ${JSON.stringify(mine.map(a => a.name))} — an album Bob is only an editor of is not his to offer`
  );
});

test('the owner travels with the album, taken from albumUsers', () => {
  const [only] = albumsIPublish([immichAlbum()], 'u-bob');
  assert.equal(only.ownerUserId, 'u-bob');
  assert.equal(only.ownerName, 'Bob');
});

test('an album with no owner entry is skipped rather than guessed', () => {
  const orphan = immichAlbum({ albumUsers: [{ user: { id: 'u-bob', name: 'Bob' }, role: 'editor' }] });
  assert.deepEqual(albumsIPublish([orphan], 'u-bob'), []);
});

test('name normalisation is for recall: case and whitespace are not differences', () => {
  assert.equal(normaliseAlbumName('  Summer   2024 '), normaliseAlbumName('summer 2024'));
  assert.equal(normaliseAlbumName('SUMMER 2024'), normaliseAlbumName('summer 2024'));
  // punctuation and accents are NOT stripped: two albums differing there are still named the same
  // way to a human, but guessing at equivalence is how "2024" matches "2024 (1)".
  assert.notEqual(normaliseAlbumName('Summer 2024!'), normaliseAlbumName('Summer 2024'));
});

test('a same-named album owned by the other person is a candidate', () => {
  const mine = [album({})];
  const theirs = [album({ ownerUserId: 'u-bob', ownerName: 'Bob', assetCount: 20 })];
  const found = matchAlbums(mine, theirs);
  assert.equal(found.length, 1, `expected one candidate, got ${JSON.stringify(found)}`);
  assert.equal(found[0].mine.name, 'Summer 2024');
  assert.equal(found[0].theirs.ownerName, 'Bob');
});

test('generic names are still offered, and the record says why', () => {
  // §6: the human confirms, so a weak signal is a candidate to review rather than a silent merge.
  const found = matchAlbums(
    [album({ name: 'Photos' })],
    [album({ name: 'photos', ownerUserId: 'u-bob', ownerName: 'Bob' })]
  );
  assert.equal(found.length, 1);
  assert.match(found[0].why, /name/i, `reason should name the signal it used: ${found[0].why}`);
});

test('different names never match, however close the dates', () => {
  const found = matchAlbums(
    [album({ name: 'Summer 2024' })],
    [album({ name: 'Winter 2024', ownerUserId: 'u-bob', ownerName: 'Bob' })]
  );
  assert.deepEqual(found, [], `matched on something other than the name: ${JSON.stringify(found)}`);
});

test('the peer never matches itself back: identical owner is not a candidate', () => {
  const found = matchAlbums([album({})], [album({})]);
  assert.deepEqual(found, [], 'an album owned by the same person is not a reunification');
});

test('an unreadable date orders lower but does not hide the candidate', () => {
  const withDates = matchAlbums(
    [album({})],
    [
      album({ ownerUserId: 'u-bob', ownerName: 'Bob' }),
      album({ ownerUserId: 'u-carol', ownerName: 'Carol', startDate: undefined, endDate: undefined }),
    ]
  );
  assert.equal(withDates.length, 2, 'a missing date must not drop a same-named album');
  assert.equal(withDates[0].theirs.ownerName, 'Bob', 'the overlapping-dates candidate should rank first');
});

test('the same name on both sides of three people yields one candidate per other owner', () => {
  const found = matchAlbums(
    [album({})],
    [album({ ownerUserId: 'u-bob', ownerName: 'Bob' }), album({ ownerUserId: 'u-carol', ownerName: 'Carol' })]
  );
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(f => f.theirs.ownerName).sort(), ['Bob', 'Carol']);
});

// Rows arrive from a peer's client or from Immich, so a malformed album is skipped rather than
// thrown over: the sidecar has to fail open.
test('a malformed album is dropped, never thrown over', () => {
  const junk = [
    { albumName: 'albumUsers as an object', albumUsers: {} },
    { albumName: 'albumUsers with nulls', albumUsers: [null, { user: null, role: 'owner' }] },
    { albumName: 'no albumUsers at all' },
    null,
    'a string',
  ];
  assert.deepEqual(albumsIPublish(junk, 'u-me'), [], 'every malformed entry must be skipped');
});

test('one malformed album does not hide the good ones beside it', () => {
  const good = {
    albumName: 'Mine',
    assetCount: 2,
    albumUsers: [{ user: { id: 'u-me', name: 'Me' }, role: 'owner' }],
  };
  const published = albumsIPublish([{ albumUsers: 'not an array' }, good], 'u-me');
  assert.deepEqual(
    published.map(a => a.name),
    ['Mine']
  );
});
