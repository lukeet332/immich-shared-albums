/**
 * store-schema.test.ts — the schema-version contract on state.db.
 *
 * v0 shipped to nobody, so there is deliberately no migration — but the refusal must be a
 * sentence a human can act on, never raw SQL errors from mismatched columns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from './store.ts';

test('a fresh database is stamped with the current schema version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-fresh-'));
  const store = new Store(dir);
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION
  );
  assert.equal(store.state.identity, null, 'identity is minted by state.ts, not the store');
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pre-v1 database is refused with instructions, not SQL errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-v0-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  // the v0 signature: collections as kv blobs, identity under the old name
  db.exec(`CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
           CREATE TABLE seen (m TEXT, c TEXT, l TEXT, o TEXT);`);
  db.prepare('INSERT INTO kv (name, value) VALUES (?, ?)').run('keys', '{"pub":"x","priv":"y"}');
  db.close();
  assert.throws(() => new Store(dir), /pre-v1 build.*delete the data volume/s);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown future schema version is refused rather than guessed at', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-future-'));
  const fresh = new Store(dir);
  fresh.db.exec('PRAGMA user_version = 99');
  fresh.db.close();
  assert.throws(() => new Store(dir), /schema v99/);
  fs.rmSync(dir, { recursive: true, force: true });
});
