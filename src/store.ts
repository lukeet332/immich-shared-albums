/**
 * SQLite-backed state store (node:sqlite — built into Node, still zero dependencies).
 *
 * Hot ledgers (seen, seenActivity) live as indexed tables: lookups that were O(n)
 * array scans per photo per cycle become indexed SELECTs, and appends stop rewriting
 * the whole state file. Small collections (keys, peers, mappings, contributors) stay
 * as an in-memory object persisted to a kv table in one transaction — same ergonomics
 * as before, now crash-safe (WAL).
 *
 * A legacy state.json is migrated on first boot and kept as state.json.migrated.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type SeenEntry = { m: string; c: string; l: string; o?: string };

export type Mapping = {
  id: string; role: 'owner' | 'member'; albumId: string; albumName: string;
  peer: string; remoteAlbumId?: string; remoteMappingId?: string;
  permissions?: 'view' | 'contribute'; adminSlug?: string;
  dead?: boolean; failCount?: number;
  localVersion?: string; remoteVersion?: string;
  commentCount?: number; remoteCommentCount?: number;
};

export type Peer = { pub: string; url: string; name: string; version?: string };
export type Contributor = { userId: string; key: string; password: string; avatarDone?: boolean };

export type Collections = {
  keys: { pub: string; priv: string } | null;
  peers: Peer[];
  mappings: Mapping[];
  contributors: Record<string, Contributor>;
};

export class Store {
  db: DatabaseSync;
  state: Collections;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, 'state.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (m TEXT NOT NULL, c TEXT NOT NULL, l TEXT NOT NULL, o TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS seen_mc ON seen (m, c);
      CREATE INDEX IF NOT EXISTS seen_l ON seen (l);
      CREATE TABLE IF NOT EXISTS seen_activity (tag TEXT PRIMARY KEY);
    `);
    this.migrateLegacyJson(dataDir);
    this.state = {
      keys: this.kvGet('keys'),
      peers: this.kvGet('peers') ?? [],
      mappings: this.kvGet('mappings') ?? [],
      contributors: this.kvGet('contributors') ?? {},
    };
  }

  private kvGet(name: string) {
    const row = this.db.prepare('SELECT value FROM kv WHERE name = ?').get(name) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  private migrateLegacyJson(dataDir: string) {
    const legacy = path.join(dataDir, 'state.json');
    const already = this.db.prepare('SELECT 1 FROM kv LIMIT 1').get();
    if (already || !fs.existsSync(legacy)) return;
    const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const put = this.db.prepare('INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)');
    const seenIns = this.db.prepare('INSERT OR IGNORE INTO seen (m, c, l, o) VALUES (?, ?, ?, ?)');
    const actIns = this.db.prepare('INSERT OR IGNORE INTO seen_activity (tag) VALUES (?)');
    this.db.exec('BEGIN');
    try {
      for (const name of ['keys', 'peers', 'mappings', 'contributors']) {
        if (old[name] != null) put.run(name, JSON.stringify(old[name]));
      }
      for (const s of old.seen ?? []) seenIns.run(s.m, s.c, s.l, s.o ?? null);
      for (const tag of old.seenActivity ?? []) actIns.run(tag);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    fs.renameSync(legacy, `${legacy}.migrated`);
    console.log(new Date().toISOString(), `migrated state.json -> state.db (${(old.seen ?? []).length} ledger entries)`);
  }

  /** Persist the in-memory collections (small; one transaction). */
  save() {
    const put = this.db.prepare('INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      put.run('keys', JSON.stringify(this.state.keys));
      put.run('peers', JSON.stringify(this.state.peers));
      put.run('mappings', JSON.stringify(this.state.mappings));
      put.run('contributors', JSON.stringify(this.state.contributors));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  seenHas(mappingId: string, checksum: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen WHERE m = ? AND c = ?').get(mappingId, checksum);
  }
  seenAdd(mappingId: string, checksum: string, localAssetId: string, originAsset?: string) {
    this.db.prepare('INSERT OR IGNORE INTO seen (m, c, l, o) VALUES (?, ?, ?, ?)')
      .run(mappingId, checksum, localAssetId, originAsset ?? null);
  }
  /** The authoritative ledger entry for a local asset. A deduped proxy can carry rows
   *  from several mappings/eras; materialisation rows (with an origin asset) hold the
   *  TRUE wire identity, so they always win over watcher-push bookkeeping rows. */
  ledgerByAsset(assetId: string): SeenEntry | undefined {
    return this.db.prepare(
      'SELECT m, c, l, o FROM seen WHERE l = ? ORDER BY (o IS NOT NULL) DESC, rowid DESC LIMIT 1'
    ).get(assetId) as SeenEntry | undefined;
  }
  /** Ledger entry that can chain to the owner (has an origin asset id). */
  ledgerWithOrigin(assetId: string): SeenEntry | undefined {
    return this.db.prepare(
      'SELECT m, c, l, o FROM seen WHERE l = ? AND o IS NOT NULL ORDER BY rowid DESC LIMIT 1'
    ).get(assetId) as SeenEntry | undefined;
  }
  seenRemoveMapping(mappingId: string) {
    this.db.prepare('DELETE FROM seen WHERE m = ?').run(mappingId);
  }
  seenForMapping(mappingId: string): SeenEntry[] {
    return this.db.prepare('SELECT m, c, l, o FROM seen WHERE m = ?').all(mappingId) as SeenEntry[];
  }
  seenRemoveEntry(mappingId: string, checksum: string) {
    this.db.prepare('DELETE FROM seen WHERE m = ? AND c = ?').run(mappingId, checksum);
  }

  seenActHas(tag: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen_activity WHERE tag = ?').get(tag);
  }
  seenActAdd(tag: string) {
    this.db.prepare('INSERT OR IGNORE INTO seen_activity (tag) VALUES (?)').run(tag);
  }
}
