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

test('a v1 database migrates to v2 by adding the storedFull column, keeping existing rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-v1-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  // a v1 store: the seen table WITHOUT storedFull, stamped v1, and not the v0 signature (no kv 'keys')
  db.exec(`
    CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE seen (
      id INTEGER PRIMARY KEY, mapping TEXT NOT NULL, checksum TEXT NOT NULL,
      localAsset TEXT NOT NULL, originAsset TEXT
    );
    PRAGMA user_version = 1;
  `);
  db.prepare('INSERT INTO seen (mapping, checksum, localAsset, originAsset) VALUES (?, ?, ?, ?)').run(
    'm1',
    'c1',
    'a1',
    'o1'
  );
  db.close();

  const store = new Store(dir);
  assert.equal(SCHEMA_VERSION, 2, 'this migration targets schema v2');
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
    'the v1 db is migrated up, not refused'
  );
  const row = store.seenForMapping('m1')[0];
  assert.equal(row.localAsset, 'a1', 'pre-existing rows survive the migration');
  assert.equal(row.storedFull, 0, 'the added column defaults to 0 (a stub) for old rows');
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
