/** store.ts — SQLite-backed state (node:sqlite, so still zero dependencies). See store.md. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export type SeenEntry = { m: string; c: string; l: string; o?: string };

export type Mapping = {
  id: string;
  role: 'owner' | 'member';
  albumId: string;
  albumName: string;
  peer: string;
  remoteAlbumId?: string;
  remoteMappingId?: string;
  permissions?: 'view' | 'contribute';
  adminSlug?: string;
  via?: 'link' | 'invite';
  forPeerUserIds?: string[];
  albumOwnerName?: string;
  dead?: boolean;
  failCount?: number;
  localVersion?: string;
  remoteVersion?: string;
  commentCount?: number;
  remoteCommentCount?: number;
};

export type Peer = { pub: string; url: string; name: string; version?: string };
export type Contributor = {
  userId: string;
  key: string;
  password?: string;
  avatarDone?: boolean;
  peer?: string;
  peerUserId?: string;
  /** The server this person lives on. Set ONLY by a directory sync. store.md. */
  homePeer?: string;
};

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, size INTEGER NOT NULL, lastUsed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cache_lru ON cache (lastUsed);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS offered (m TEXT NOT NULL, a TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS offered_ma ON offered (m, a);
      CREATE INDEX IF NOT EXISTS offered_a ON offered (a);
      -- Album memberships THIS SIDECAR created (album id, user id). See addedRecord: it is the
      -- difference between "a human invited them" and "we put them there for attribution", and
      -- getting it wrong in the unsafe direction shares an album nobody offered.
      CREATE TABLE IF NOT EXISTS added (al TEXT NOT NULL, us TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS added_alus ON added (al, us);
      CREATE INDEX IF NOT EXISTS added_us ON added (us);
    `);
    this.state = {
      keys: this.kvGet('keys'),
      peers: this.kvGet('peers') ?? [],
      mappings: this.kvGet('mappings') ?? [],
      contributors: this.kvGet('contributors') ?? {},
    };
  }

  kv(name: string) {
    return this.kvGet(name);
  }
  kvSet(name: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)').run(name, JSON.stringify(value));
  }

  private kvGet(name: string) {
    const row = this.db.prepare('SELECT value FROM kv WHERE name = ?').get(name) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

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
    this.db
      .prepare('INSERT OR IGNORE INTO seen (m, c, l, o) VALUES (?, ?, ?, ?)')
      .run(mappingId, checksum, localAssetId, originAsset ?? null);
  }
  ledgerByAsset(assetId: string): SeenEntry | undefined {
    return this.db
      .prepare('SELECT m, c, l, o FROM seen WHERE l = ? ORDER BY (o IS NOT NULL) DESC, rowid DESC LIMIT 1')
      .get(assetId) as (SeenEntry & { o: string }) | undefined;
  }
  ledgerWithOrigin(assetId: string): (SeenEntry & { o: string }) | undefined {
    return this.db
      .prepare('SELECT m, c, l, o FROM seen WHERE l = ? AND o IS NOT NULL ORDER BY rowid DESC LIMIT 1')
      .get(assetId) as (SeenEntry & { o: string }) | undefined;
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

  offeredAdd(mappingId: string, assetIds: string[]) {
    if (!assetIds.length) return;
    const ins = this.db.prepare('INSERT OR IGNORE INTO offered (m, a) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const a of assetIds) ins.run(mappingId, a);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  offeredAllows(mappingIds: string[], assetId: string): boolean {
    if (!mappingIds.length) return false;
    const holes = mappingIds.map(() => '?').join(',');
    return !!this.db
      .prepare(`SELECT 1 FROM offered WHERE a = ? AND m IN (${holes})`)
      .get(assetId, ...mappingIds);
  }
  /** Callers MUST record BEFORE the add lands — that order fails towards under-sharing. store.md. */
  addedRecord(albumId: string, userId: string) {
    this.db.prepare('INSERT OR IGNORE INTO added (al, us) VALUES (?, ?)').run(albumId, userId);
  }
  addedHas(albumId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM added WHERE al = ? AND us = ?').get(albumId, userId);
  }
  addedForget(albumId: string, userId: string) {
    this.db.prepare('DELETE FROM added WHERE al = ? AND us = ?').run(albumId, userId);
  }
  addedAlbumsFor(userId: string): string[] {
    return (this.db.prepare('SELECT al FROM added WHERE us = ?').all(userId) as { al: string }[]).map(
      r => r.al
    );
  }
  addedRemoveUser(userId: string) {
    this.db.prepare('DELETE FROM added WHERE us = ?').run(userId);
  }

  offeredRemoveMapping(mappingId: string) {
    this.db.prepare('DELETE FROM offered WHERE m = ?').run(mappingId);
  }

  seenActHas(tag: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen_activity WHERE tag = ?').get(tag);
  }
  seenActAdd(tag: string) {
    this.db.prepare('INSERT OR IGNORE INTO seen_activity (tag) VALUES (?)').run(tag);
  }

  cacheTouch(key: string): boolean {
    const hit = this.db.prepare('SELECT 1 FROM cache WHERE key = ?').get(key);
    if (hit) this.db.prepare('UPDATE cache SET lastUsed = ? WHERE key = ?').run(Date.now(), key);
    return !!hit;
  }
  cachePut(key: string, size: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO cache (key, size, lastUsed) VALUES (?, ?, ?)')
      .run(key, size, Date.now());
  }
  cacheTotal(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM cache').get() as { n: number }).n;
  }
  cacheEvictOldest(): { key: string; size: number } | undefined {
    const row = this.db.prepare('SELECT key, size FROM cache ORDER BY lastUsed ASC LIMIT 1').get() as
      { key: string; size: number } | undefined;
    if (row) this.db.prepare('DELETE FROM cache WHERE key = ?').run(row.key);
    return row;
  }
}
