/**
 * store-migration.test.ts — the v0 -> v1 state migration, proven on a hand-built v0 database.
 *
 * The one migration that must never be guesswork: v0 is what the two real pre-v1 installs
 * hold, and getting key conversion wrong would orphan their pairings silently. The v0 shape
 * below is copied from the actual pre-v1 store.ts, not reconstructed from memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from './store.ts';

const derKeypair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    rawPub: (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    seed: (privateKey.export({ format: 'jwk' }) as { d: string }).d,
  };
};

function buildV0(dir: string) {
  const self = derKeypair();
  const peerKey = derKeypair();
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`
    CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE seen (m TEXT NOT NULL, c TEXT NOT NULL, l TEXT NOT NULL, o TEXT);
    CREATE UNIQUE INDEX seen_mc ON seen (m, c);
    CREATE TABLE seen_activity (tag TEXT PRIMARY KEY);
    CREATE TABLE offered (m TEXT NOT NULL, a TEXT NOT NULL);
    CREATE TABLE added (al TEXT NOT NULL, us TEXT NOT NULL);
  `);
  const put = db.prepare('INSERT INTO kv (name, value) VALUES (?, ?)');
  put.run('keys', JSON.stringify({ pub: self.pub, priv: self.priv }));
  put.run('peers', JSON.stringify([{ pub: peerKey.pub, name: 'The Smiths', version: '0.5.0' }]));
  put.run(
    'mappings',
    JSON.stringify([
      // a pre-`via` link mapping with the old field names and no permissions
      { id: 'map-1', role: 'owner', albumId: 'alb-1', albumName: 'Holiday', peer: peerKey.pub },
      {
        id: 'map-2',
        role: 'member',
        albumId: 'alb-2',
        albumName: 'Mirror',
        peer: peerKey.pub,
        adminSlug: 'person-owner9',
        permissions: 'contribute',
        via: 'invite',
        dead: true,
      },
    ])
  );
  put.run(
    'contributors',
    JSON.stringify({
      'person-owner9': { userId: 'u-9', key: 'api-key-9', peer: peerKey.pub, homePeer: peerKey.pub },
    })
  );
  put.run('pairings', JSON.stringify([]));
  db.prepare('INSERT INTO seen (m, c, l, o) VALUES (?, ?, ?, ?)').run('map-2', 'ck1', 'local1', 'origin1');
  db.prepare('INSERT INTO offered (m, a) VALUES (?, ?)').run('map-1', 'asset-1');
  db.prepare('INSERT INTO added (al, us) VALUES (?, ?)').run('alb-1', 'u-9');
  db.prepare('INSERT INTO seen_activity (tag) VALUES (?)').run('remote:act1');
  db.close();
  return { self, peerKey };
}

test('a v0 state.db migrates whole: same keys, new envelopes, every row preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-migrate-'));
  const { self, peerKey } = buildV0(dir);

  const store = new Store(dir);
  // identity: the SAME key, re-encoded raw
  assert.equal(store.state.identity?.pub, self.rawPub, 'public key must survive re-encoding');
  assert.equal(store.state.identity?.priv, self.seed, 'private seed must survive re-encoding');
  assert.equal(store.state.identity?.alg, 'ed25519');
  // peers: converted pub, stamped provenance
  assert.equal(store.state.peers.length, 1);
  assert.equal(store.state.peers[0].pub, peerKey.rawPub);
  assert.equal(store.state.peers[0].via, 'pair');
  assert.ok(store.state.peers[0].firstSeenAt);
  // mappings: renamed fields, defaulted discriminators, converted peer refs
  const m1 = store.state.mappings.find(m => m.id === 'map-1');
  const m2 = store.state.mappings.find(m => m.id === 'map-2');
  assert.equal(m1?.via, 'link', 'pre-via mappings default to link');
  assert.equal(m1?.permissions, 'view', 'missing permissions fail closed');
  assert.equal(m1?.peer, peerKey.rawPub);
  assert.equal(m2?.hostSlug, 'person-owner9', 'adminSlug becomes hostSlug');
  assert.equal(m2?.dead, true);
  // contributors: key -> apiKey, peer -> viaPeer (converted)
  const c = store.state.contributors['person-owner9'];
  assert.equal(c?.apiKey, 'api-key-9');
  assert.equal(c?.viaPeer, peerKey.rawPub);
  assert.equal(c?.homePeer, peerKey.rawPub);
  // ledgers: rows carried over under the new columns
  assert.ok(store.seenHas('map-2', 'ck1'));
  assert.equal(store.ledgerWithOrigin('local1')?.originAsset, 'origin1');
  assert.ok(store.offeredAllows(['map-1'], 'asset-1'));
  assert.ok(store.addedHas('alb-1', 'u-9'));
  assert.ok(store.seenActHas('remote:act1'));
  // stamped, old blobs gone, and a re-open must NOT re-migrate
  assert.equal(
    (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION
  );
  assert.equal(store.kv('keys'), null, 'old kv blobs must be deleted');
  store.db.close();
  const again = new Store(dir);
  assert.equal(again.state.peers[0].pub, peerKey.rawPub, 'second open reads, never re-migrates');
  again.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

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
