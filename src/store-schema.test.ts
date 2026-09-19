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

// The reunification facts. Recorded rather than inferred: an adopted album belongs to a human who
// had it before the share, and whether it is part of a reunion is a different fact again — deriving
// either from the album's contents would mean deciding whose photos they are at deletion time.
test('a v2 database migrates to v3 by adding the reunification facts, keeping existing mappings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-v2-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  // a v2 mappings table: real columns, but without `adopted`/`reunified`, stamped v2
  db.exec(`
    CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE seen (
      id INTEGER PRIMARY KEY, mapping TEXT NOT NULL, checksum TEXT NOT NULL,
      localAsset TEXT NOT NULL, originAsset TEXT, storedFull INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE mappings (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, albumId TEXT NOT NULL, albumName TEXT NOT NULL,
      peer TEXT NOT NULL, remoteAlbumId TEXT, remoteMappingId TEXT,
      permissions TEXT NOT NULL, hostSlug TEXT, via TEXT NOT NULL, forPeerUserIds TEXT,
      albumOwnerName TEXT, albumOwnerId TEXT, dead INTEGER NOT NULL DEFAULT 0,
      deadAt TEXT, deadReason TEXT, failCount INTEGER, localVersion TEXT, remoteVersion TEXT,
      commentCount INTEGER, remoteCommentCount INTEGER
    );
    CREATE TABLE peers (pub TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT, protocol INTEGER,
      features TEXT, via TEXT NOT NULL, firstSeenAt TEXT NOT NULL, relayHint TEXT, lastAddrs TEXT);
    CREATE TABLE contributors (slug TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE, apiKey TEXT NOT NULL,
      password TEXT, avatarDone INTEGER NOT NULL DEFAULT 0, viaPeer TEXT, peerUserId TEXT, homePeer TEXT);
    PRAGMA user_version = 2;
  `);
  db.prepare(
    `INSERT INTO mappings (id, role, albumId, albumName, peer, permissions, via)
     VALUES ('m1', 'owner', 'alb-1', 'Summer 2024', 'peer-1', 'contribute', 'invite')`
  ).run();
  db.close();

  const store = new Store(dir);
  assert.equal(SCHEMA_VERSION, 4, 'this migration chain targets schema v4');
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
    'the v2 db is migrated up, not refused'
  );
  const mapping = store.state.mappings.find(m => m.id === 'm1');
  assert.ok(mapping, 'pre-existing mappings survive the migration');
  assert.equal(mapping.adopted, undefined, 'an existing mapping is not retroactively marked adopted');
  assert.equal(mapping.reunified, undefined, 'nor retroactively marked reunified');
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// v3 -> v4: the album index gained a direction. A v3 row is keyed by peer alone, so whether it was
// what this server OFFERS that peer or what it RECEIVED from them is not recoverable — and guessing
// wrong serves a peer its own albums back. Both halves rebuild from living sources, so the migration
// drops them rather than inventing a direction.
test('a v3 album index loses rows whose direction cannot be known', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-v3-index-'));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`
    CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE published_albums (
      peer TEXT NOT NULL, ownerUserId TEXT NOT NULL, name TEXT NOT NULL,
      assetCount INTEGER NOT NULL DEFAULT 0, startDate TEXT, endDate TEXT,
      ownerName TEXT NOT NULL DEFAULT ''
    );
    PRAGMA user_version = 3;
  `);
  db.prepare(
    `INSERT INTO published_albums (peer, ownerUserId, name, ownerName)
     VALUES ('peer-1', 'u-bob', 'Bob album', 'Bob')`
  ).run();
  db.close();

  const store = new Store(dir);
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
    'the v3 db is migrated up, not refused'
  );
  assert.deepEqual(store.publishedAlbumsFor('peer-1', 'to-them'), [], 'no invented offer');
  assert.deepEqual(store.publishedAlbumsFor('peer-1', 'from-them'), [], 'no invented receipt');
  store.db.close();
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

test('a v1 database migrates the whole chain, keeping existing rows', () => {
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
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
    'the v1 db is migrated up, not refused'
  );
  const row = store.seenForMapping('m1')[0];
  assert.equal(row.localAsset, 'a1', 'pre-existing rows survive the migration');
  assert.equal(row.storedFull, 0, 'the v2 column defaults to 0 (a stub) for old rows');
  // and it keeps going: v1 is brought all the way up, not left at v2
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
    'a v1 database reaches the current schema, not an intermediate one'
  );
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
