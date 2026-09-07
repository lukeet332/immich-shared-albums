/** store.test.ts — behavioural contracts for the SQLite-backed ledgers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';

test('a deduped local asset is retained while another mapping references it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-store-'));
  const store = new Store(dir);
  try {
    store.seenAdd('mapping-1', 'checksum-1', 'asset-1', 'origin-1', true);
    store.seenAdd('mapping-2', 'checksum-2', 'asset-1', 'origin-1', true);
    assert.equal(store.seenAssetUsedOutsideMapping('asset-1', 'mapping-1'), true);
    store.seenRemoveMapping('mapping-2');
    assert.equal(store.seenAssetUsedOutsideMapping('asset-1', 'mapping-1'), false);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
