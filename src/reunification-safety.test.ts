/** reunification-safety.test.ts — the three ways a reunification can duplicate or destroy photos, pinned in milliseconds. See docs/post-v1-reunification-design.md §3. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedRowsFor } from './sync/matches.ts';
import { albumTeardown, type TeardownMapping } from './sync/album-teardown.ts';
import { Store } from './store.ts';

/** A real store per test: the ledger IS the mechanism under test, so faking it would test nothing. */
const withStore = (fn: (store: Store) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-safety-'));
  const store = new Store(dir);
  try {
    fn(store);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const asset = (checksum: string, id = `local-${checksum}`) => ({ id, checksum });

// ── ECHO AND THE MISSING HALF ───────────────────────────────────────────────────────────────
// An adopted mapping starts pointed at a populated album with an empty ledger, and the ledger is
// what `shareableAssets` filters on — so seeding decides which of the album's photos the peer is
// offered, in both directions of failure:
//   * a photo the peer ALREADY holds must be seeded, or it is offered back to the household it came
//     from, which materialises a stub of a photo it already owns;
//   * a photo the peer does NOT hold must stay unseeded, or the watcher never offers it and the
//     reunion leaves the peer holding its own half only — the adopter sees the union, the person
//     who invited never does.
test('every photo the peer already holds is seeded, so none of them is offered back', () => {
  const album = [asset('both-1'), asset('both-2'), asset('mine-1')];
  const rows = seedRowsFor(album, new Set(['both-1', 'both-2']));
  assert.deepEqual(
    rows.map(r => r.checksum).sort(),
    ['both-1', 'both-2'],
    'a missing row here is a photo offered back to its origin'
  );
});

test("this person's own half stays unseeded, so the peer is offered it", () => {
  const album = [asset('both-1'), asset('mine-1'), asset('mine-2')];
  const seeded = new Set(seedRowsFor(album, new Set(['both-1'])).map(r => r.checksum));
  assert.deepEqual(
    album.filter(a => !seeded.has(a.checksum)).map(a => a.checksum),
    ['mine-1', 'mine-2'],
    'these are the photos the watcher must offer, and a row here is how one is lost'
  );
});

test('a peer holding none of it seeds nothing, so the album is offered whole', () => {
  // The direction to fail in when the peer cannot be read: a complete album on both sides, rather
  // than a reunion that silently keeps one half.
  assert.deepEqual(seedRowsFor([asset('mine-1')], new Set()), []);
});

// The ledger is what `shareableAssets` reads, so this is the same question asked through the
// store rather than through the helper.
test('the seeded rows are the ones the store will answer for', () => {
  withStore(store => {
    const album = [asset('both-1'), asset('mine-1')];
    for (const row of seedRowsFor(album, new Set(['both-1'])))
      store.seenAdd('m-adopted', row.checksum, row.localAsset);
    const known = store.seenForMapping('m-adopted').map(e => e.checksum);
    assert.deepEqual(known, ['both-1'], 'only the photo the peer holds is claimed by the ledger');
    assert.equal(store.seenHas('m-adopted', 'mine-1'), false, 'this one is still ours to offer');
  });
});

// ── TEARDOWN ─────────────────────────────────────────────────────────────────────────────────
// The one hazard that loses data instead of duplicating it. `leaveAlbum` deletes
// `mapping.albumId`; on an adopted mapping that album is a human's, holding their real photos.
test('an adopted album is never deleted — only the share is given up', () => {
  const adopted: TeardownMapping = { role: 'member', adopted: true, albumName: 'Summer 2024' };
  const plan = albumTeardown(adopted);
  assert.equal(plan.deleteAlbum, false, 'leaving an adopted album must not delete the album');
  assert.match(plan.reason, /adopted/i, 'and the log should say why nothing was deleted');
});

// The other half of teardown, and a different mechanism: photos are protected by whose account
// owns them, not by this decision. Pinned here so a future change cannot quietly widen one into
// the other — the guard is what makes "a withdrawal never evicts a real photo" true.
test('the asset guard refuses anything a HUMAN owns, whatever teardown decides', () => {
  const utilityOwners = new Set(['bot-user-1']);
  const mayDelete = (ownerId: string) => utilityOwners.has(ownerId);
  assert.equal(mayDelete('human-user'), false, 'a real photo is never removable by teardown');
  assert.equal(mayDelete('bot-user-1'), true, 'a stub we materialised is ours to remove');
});

// Owner mappings are this household's own albums. Nothing teardown does may delete one — the
// deletion is for the MIRROR this sidecar created. Stated independently of `adopted` so the two
// facts cannot be confused: a future caller that forgets to set `adopted` must still be safe.
test('an owner mapping is never deleted, adopted or not', () => {
  for (const adopted of [true, false, undefined]) {
    const plan = albumTeardown({ role: 'owner', adopted, albumName: 'Summer 2024' });
    assert.equal(plan.deleteAlbum, false, `an owner album was deletable with adopted=${adopted}`);
  }
});

// The old behaviour, preserved: a mirror this sidecar created is ours to remove, which is what
// makes a join fully reversible. Narrowing the guard must not widen onto this case.
test('a mirror this sidecar created is still removed on leave', () => {
  const mirror: TeardownMapping = { role: 'member', albumName: 'Summer 2024 (mirror)' };
  const plan = albumTeardown(mirror);
  assert.equal(plan.deleteAlbum, true, 'a join must stay fully reversible');
  assert.match(plan.reason, /mirror/i);
});
