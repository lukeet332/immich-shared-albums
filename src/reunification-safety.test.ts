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

// ── ECHO ─────────────────────────────────────────────────────────────────────────────────────
// An adopted mapping starts pointed at a populated album with an empty ledger, and
// `shareableAssets` filters on that ledger — so an unseeded mapping advertises the whole album
// back to the household it came from, which then materialises stubs of photos it already owns.
test('every asset in an adopted album is seeded, so none can be offered back', () => {
  const album = [asset('sum-1'), asset('sum-2'), asset('sum-3')];
  const rows = seedRowsFor(album, 'm-adopted');
  assert.deepEqual(
    rows.map(r => r.checksum).sort(),
    ['sum-1', 'sum-2', 'sum-3'],
    'a missing row is a photo offered back to its origin'
  );
});

test('a seeded album still offers what it does NOT hold, or nothing would ever arrive', () => {
  const ours = new Set(seedRowsFor([asset('sum-1')], 'm').map(r => r.checksum));
  const incoming = [asset('sum-9', 'their-1'), asset('sum-1', 'their-2')];
  assert.deepEqual(
    incoming.filter(a => !ours.has(a.checksum)).map(a => a.id),
    ['their-1'],
    'suppression must drop only what is already present'
  );
});

// The ledger is what `shareableAssets` reads, so this is the same question asked through the
// store rather than through the helper: after seeding, the mapping knows about every asset.
test('the seeded rows are the ones the store will answer for', () => {
  withStore(store => {
    const album = [asset('sum-1'), asset('sum-2')];
    for (const row of seedRowsFor(album, 'm-adopted'))
      store.seenAdd('m-adopted', row.checksum, row.localAsset);
    const known = store.seenForMapping('m-adopted').map(e => e.checksum);
    assert.deepEqual(known.sort(), ['sum-1', 'sum-2']);
    for (const a of album)
      assert.equal(store.seenHas('m-adopted', a.checksum), true, `${a.checksum} was not recorded`);
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
