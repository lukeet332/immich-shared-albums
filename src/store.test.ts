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
