/** matches.test.ts — the pure half of reunification matching. See matches.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  albumsIPublish,
  matchAlbums,
  matchesWithPeer,
  normaliseAlbumName,
  reunionStepFor,
  seedRowsFor,
  type OwnedAlbum,
} from './matches.ts';

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

// A peer's Immich can hold the same name twice — a Takeout imported twice, a name reused two years
// running — and the panel renders a row per PAIRING, so both would read identically: same owner,
// same counts, same dates, same button. Every action here is resolved by NAME (`canUnifyOwnAlbum`
// for the album, the mapping for the share), so the two rows would also DO the same thing. A row a
// person can neither tell from another nor act on differently is noise in the one list they read.
test('the same name twice on the peer, with nothing to tell them apart, shows once', () => {
  const found = matchAlbums(
    [album({})],
    [
      album({ ownerUserId: 'u-bob', ownerName: 'Bob', assetCount: 20 }),
      album({ ownerUserId: 'u-bob', ownerName: 'Bob', assetCount: 20 }),
    ]
  );
  assert.equal(found.length, 1, `the same pairing twice: ${JSON.stringify(found)}`);
});

test('but same-named albums holding different things are each their own candidate', () => {
  const found = matchAlbums(
    [album({})],
    [
      album({ ownerUserId: 'u-bob', ownerName: 'Bob', assetCount: 20 }),
      album({ ownerUserId: 'u-bob', ownerName: 'Bob', assetCount: 41 }),
    ]
  );
  assert.equal(
    found.length,
    2,
    `a person can tell these apart: ${JSON.stringify(found.map(f => f.theirs.assetCount))}`
  );
});

test('and so are the same name and count under different dates', () => {
  const found = matchAlbums(
    [album({})],
    [
      album({ ownerUserId: 'u-bob', ownerName: 'Bob', assetCount: 20 }),
      album({
        ownerUserId: 'u-bob',
        ownerName: 'Bob',
        assetCount: 20,
        startDate: '2025-06-01T00:00:00.000Z',
        endDate: '2025-08-31T00:00:00.000Z',
      }),
    ]
  );
  assert.equal(found.length, 2, 'the dates are how a person tells two otherwise identical albums apart');
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

// The panel's view of a candidate: the pairing rule stays in matchAlbums, this only names whose
// server the other half is on — which is what a repair request will be routed by.
test('a candidate on a peer carries the peer it was found on', () => {
  const found = matchesWithPeer([album({})], [album({ ownerUserId: 'u-bob', ownerName: 'Bob' })], {
    pub: 'peer-pub',
    name: "Bob's server",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].peer, 'peer-pub');
  assert.equal(found[0].peerName, "Bob's server");
  assert.equal(found[0].theirs.ownerName, 'Bob');
});

test('no candidates means an empty list, not a peer record', () => {
  assert.deepEqual(matchesWithPeer([album({})], [], { pub: 'p', name: 'P' }), []);
});

// Adopting a populated album means the mapping starts with a ledger that knows nothing about the
// assets already in it. `shareableAssets` filters on `seenHas`, so an unseeded mapping advertises
// the whole album back to the peer — which materialises stubs of photos it already owns. These
// rows are what stop that, and they must be written BEFORE the mapping is visible to the loops.
test('every asset already in the album is seeded, so none of them is offered back', () => {
  const assets = [
    { id: 'a1', checksum: 'c1' },
    { id: 'a2', checksum: 'c2' },
  ];
  const rows = seedRowsFor(assets, 'm1');
  assert.deepEqual(
    rows.map(r => [r.checksum, r.localAsset]),
    [
      ['c1', 'a1'],
      ['c2', 'a2'],
    ],
    'each asset must be keyed by its wire checksum, pointing at itself'
  );
});

// The deletion-propagation loop skips entries with no originAsset. Seed rows deliberately have
// none: these are OUR photos, and a peer withdrawing its copy must never remove them.
test('seed rows carry no origin asset, so deletion propagation cannot touch them', () => {
  const rows = seedRowsFor([{ id: 'a1', checksum: 'c1' }], 'm1');
  assert.equal(rows[0].originAsset, undefined, 'an origin asset would mark it as removable');
});

test('two assets with the same checksum seed one row, not two', () => {
  // The ledger is UNIQUE on (mapping, checksum); a second row would fail the insert and abort the
  // seed half-written, which is exactly the state that leaks a partial album to the peer.
  const rows = seedRowsFor(
    [
      { id: 'a1', checksum: 'same' },
      { id: 'a2', checksum: 'same' },
    ],
    'm1'
  );
  assert.equal(rows.length, 1, `seeded ${JSON.stringify(rows)}`);
});

test('an asset with no checksum cannot be seeded, and is skipped rather than guessed at', () => {
  const rows = seedRowsFor([{ id: 'a1' }, { id: 'a2', checksum: '' }, { id: 'a3', checksum: 'c3' }], 'm1');
  assert.deepEqual(
    rows.map(r => r.localAsset),
    ['a3']
  );
});

test('an empty album seeds nothing, so adoption of an empty album is the old behaviour', () => {
  assert.deepEqual(seedRowsFor([], 'm1'), []);
});

// What a person can DO about a pairing is entirely a question of the share behind it, and the panel
// has exactly three useful states plus the one that belongs somewhere else. Kept pure and separate
// from the panel because getting a state wrong is a dead button or a row that never goes away —
// both of which have shipped here before.
test('a pairing with no share yet offers to invite them', () => {
  assert.deepEqual(reunionStepFor(undefined), { kind: 'invite' });
});

test('a share the OTHER person sent is mine to accept', () => {
  assert.deepEqual(reunionStepFor({ id: 'm1', role: 'member' }), { kind: 'accept', mappingId: 'm1' });
});

test('a share I sent them leaves me waiting rather than clicking', () => {
  // Adopting my own album is not an adoption at all: `canUnifyOwnAlbum` refuses when the share
  // already points at the album asked for, so a button here could only fail.
  assert.deepEqual(reunionStepFor({ id: 'm1', role: 'owner' }), { kind: 'waiting' });
});

test('a pairing already reunited belongs to the reunified list, not this one', () => {
  assert.deepEqual(reunionStepFor({ id: 'm1', role: 'member', reunified: true }), { kind: 'reunited' });
  assert.deepEqual(reunionStepFor({ id: 'm1', role: 'member', adopted: true }), { kind: 'reunited' });
  // The side that invited learns it over the wire, and only keeps the flag.
  assert.deepEqual(reunionStepFor({ id: 'm1', role: 'owner', reunified: true }), { kind: 'reunited' });
});

test('a share that has ENDED is no share: the pairing can be invited again', () => {
  assert.deepEqual(reunionStepFor({ id: 'm1', role: 'member', dead: true }), { kind: 'invite' });
});
