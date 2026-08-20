/**
 * SQLite-backed state store (node:sqlite — built into Node, still zero dependencies).
 *
 * Hot ledgers (seen, seenActivity) live as indexed tables: lookups that were O(n)
 * array scans per photo per cycle become indexed SELECTs, and appends stop rewriting
 * the whole state file. Small collections (keys, peers, mappings, contributors) stay
 * as an in-memory object persisted to a kv table in one transaction — same ergonomics
 * as before, now crash-safe (WAL).
 *
 */
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
  /** How this share came about. Absent means 'link' (every mapping predating invitations).
   *  Load-bearing: only 'invite' mappings may be retired by sync/invites when a peer's
   *  stand-in disappears from an album — a link-redeemed mapping never had a stand-in added
   *  to its album, so retiring those there would silently unshare every link-based album. */
  via?: 'link' | 'invite';
  /** Which people at the peer this invitation names, by their user id on their own server.
   *  Sharing is per person, so an invitation always names at least one; there is no
   *  household-wide form. The member mirrors for exactly these users and follows the list as it
   *  changes — see sync/invites.syncMirrorMembers. */
  forPeerUserIds?: string[];
  /** Display name of the album's owner, captured when an invitation is detected. Link joins
   *  learn this from the redeem response instead; without it a mirror would be named after
   *  the household rather than the person who shared it. */
  albumOwnerName?: string;
  dead?: boolean;
  failCount?: number;
  localVersion?: string;
  remoteVersion?: string;
  commentCount?: number;
  remoteCommentCount?: number;
};

export type Peer = { pub: string; url: string; name: string; version?: string };
// `password` is transient: it exists only while the account is being provisioned, and is
// rolled to an unheld value once the API key is minted (see immich/contributors.ts).
export type Contributor = {
  userId: string;
  key: string;
  password?: string;
  avatarDone?: boolean;
  /** Public key of the peer household this person belongs to. */
  peer?: string;
  /** That person's user id ON THE PEER, for invite targets — what lets an invitation be routed
   *  to one specific person rather than the whole household. */
  peerUserId?: string;
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
    // What we have ADVERTISED to each mapping's peer. A signature proves which peer is
    // calling; this table is what decides whether that peer may read a given asset's
    // bytes. Without it the byte routes authorise identity but not entitlement, and any
    // peer that learns an asset id can read anything in the library.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS offered (m TEXT NOT NULL, a TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS offered_ma ON offered (m, a);
      CREATE INDEX IF NOT EXISTS offered_a ON offered (a);
    `);
    this.state = {
      keys: this.kvGet('keys'),
      peers: this.kvGet('peers') ?? [],
      mappings: this.kvGet('mappings') ?? [],
      contributors: this.kvGet('contributors') ?? {},
    };
  }

  private kvGet(name: string) {
    const row = this.db.prepare('SELECT value FROM kv WHERE name = ?').get(name) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
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
    this.db
      .prepare('INSERT OR IGNORE INTO seen (m, c, l, o) VALUES (?, ?, ?, ?)')
      .run(mappingId, checksum, localAssetId, originAsset ?? null);
  }
  /** The authoritative ledger entry for a local asset. A deduped proxy can carry rows
   *  from several mappings/eras; materialisation rows (with an origin asset) hold the
   *  TRUE wire identity, so they always win over watcher-push bookkeeping rows. */
  ledgerByAsset(assetId: string): SeenEntry | undefined {
    return this.db
      .prepare('SELECT m, c, l, o FROM seen WHERE l = ? ORDER BY (o IS NOT NULL) DESC, rowid DESC LIMIT 1')
      .get(assetId) as (SeenEntry & { o: string }) | undefined;
  }
  /** Ledger entry that can chain to the owner (has an origin asset id). */
  /** A ledger row that definitely has an origin asset: the SQL filters `o IS NOT NULL`,
   *  so the type says so and callers stop re-checking what the query already guaranteed. */
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

  // ---- offered index: which assets each mapping's peer is entitled to read ----
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
  /** Has any of these mappings advertised this asset? Empty list => never. */
  offeredAllows(mappingIds: string[], assetId: string): boolean {
    if (!mappingIds.length) return false;
    const holes = mappingIds.map(() => '?').join(',');
    return !!this.db
      .prepare(`SELECT 1 FROM offered WHERE a = ? AND m IN (${holes})`)
      .get(assetId, ...mappingIds);
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

  // ---- bounded LRU byte-cache accounting (files live in <dataDir>/cache) ----
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
