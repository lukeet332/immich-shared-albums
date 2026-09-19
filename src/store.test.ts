/** store.test.ts — behavioural contracts for the SQLite-backed ledgers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';

const withStore = (body: (store: Store) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-store-'));
  const storeDb = new Store(dir);
  try {
    body(storeDb);
  } finally {
    storeDb.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// leaveAlbum deletes a materialised asset unless another mapping still claims it, and it asks
// `ledgerByAsset` — the row holding the true wire identity — rather than whether any row mentions
// the id. A bookkeeping row must never be able to pin a stored copy on its own.
test('another mapping claiming the asset is visible to the leave decision', () => {
  withStore(store => {
    store.seenAdd('mapping-1', 'checksum-shared', 'asset-shared', 'origin-1', true);
    store.seenAdd('mapping-2', 'checksum-shared', 'asset-shared', 'origin-1', true);
    const owner = store.ledgerByAsset('asset-shared');
    assert.equal(owner?.mapping, 'mapping-2');
    assert.notEqual(owner?.mapping, 'mapping-1');
  });
});

test('a row with no origin asset cannot claim an asset on its own', () => {
  withStore(store => {
    store.seenAdd('mapping-1', 'checksum-1', 'asset-1', 'origin-1', true);
    // watcher-push bookkeeping for a *different* mapping, no origin: never authoritative
    store.seenAdd('mapping-2', 'checksum-1', 'asset-1', undefined, false);
    assert.equal(store.ledgerByAsset('asset-1')?.mapping, 'mapping-1');
  });
});

test('an asset only this mapping claims is left unclaimed by others', () => {
  withStore(store => {
    store.seenAdd('mapping-1', 'checksum-1', 'asset-1', 'origin-1', true);
    assert.equal(store.ledgerByAsset('asset-1')?.mapping, 'mapping-1');
    store.seenRemoveMapping('mapping-1');
    assert.equal(store.ledgerByAsset('asset-1'), undefined);
  });
});

// The two reunification facts. They round-trip or they do not exist: the whole point of recording
// them is that teardown and the member view can trust what they read back.
test('the reunification facts survive a write and a read', () => {
  withStore(store => {
    const base = {
      id: 'm-reunified',
      role: 'owner' as const,
      albumId: 'alb-1',
      albumName: 'Summer 2024',
      peer: 'peer-1',
      permissions: 'contribute' as const,
      via: 'invite' as const,
    };
    store.state.mappings.push({ ...base, adopted: true, reunified: true });
    store.save();
    const back = store.state.mappings.find(m => m.id === 'm-reunified');
    assert.equal(back?.adopted, true);
    assert.equal(back?.reunified, true);
  });
});

// Unset is not false: a mapping made the ordinary way was neither adopted nor part of a reunion,
// and "not stated" must stay distinguishable from "stated as no" so a future default cannot
// retroactively reclassify existing shares.
test('a mapping with neither fact set reads back with neither set', () => {
  withStore(store => {
    store.state.mappings.push({
      id: 'm-ordinary',
      role: 'member',
      albumId: 'alb-2',
      albumName: 'Ordinary share',
      peer: 'peer-1',
      permissions: 'contribute',
      via: 'link',
    });
    store.save();
    const back = store.state.mappings.find(m => m.id === 'm-ordinary');
    assert.equal(back?.adopted, undefined, 'adopted must not default to false');
    assert.equal(back?.reunified, undefined, 'reunified must not default to false');
    // The loaded object cannot tell NULL from 0, because the reader maps both to undefined. The
    // stored VALUE is what a migration or a query would act on, so assert it: 0 would mean an
    // existing mapping had been explicitly recorded as "not adopted", which is a different claim
    // from "never stated".
    const raw = store.db
      .prepare('SELECT adopted, reunified FROM mappings WHERE id = ?')
      .get('m-ordinary') as { adopted: unknown; reunified: unknown };
    assert.equal(raw.adopted, null, 'an unset fact must be SQL NULL, not 0');
    assert.equal(raw.reunified, null, 'an unset fact must be SQL NULL, not 0');
  });
});
