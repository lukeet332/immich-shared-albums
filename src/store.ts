/**
 * SQLite-backed state store (node:sqlite — built into Node, still zero dependencies).
 *
 * Hot ledgers (seen, seen_activity, offered, added) are indexed tables. The three core
 * collections (peers, mappings, contributors) are real tables too — every row a row,
 * every column named — but they are still held in memory as plain arrays/objects and
 * rewritten wholesale on save(): the collections are tiny (a handful of peers, tens of
 * mappings) and the shared-array ergonomics are load-bearing for the sync loops. What
 * the tables buy is a schema that PRAGMA user_version can migrate: post-1.0, a change
 * here is a numbered migration, never blob archaeology.
 *
 * SCHEMA_VERSION marks the shape this code writes. Bump it WITH a migration branch in
 * the constructor — never silently.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export const SCHEMA_VERSION = 2;

export type SeenEntry = {
  mapping: string;
  checksum: string;
  localAsset: string;
  originAsset?: string;
  /** SQLite INTEGER 0/1: 1 when the local asset holds the FULL bytes (store-shared-locally mode)
   *  rather than a stub. The byte interceptor reads this — a stored-full asset is served from the
   *  local copy instead of streamed from the owner, so it survives the owner going offline. */
  storedFull?: number;
};

export type Mapping = {
  id: string;
  role: 'owner' | 'member';
  albumId: string;
  albumName: string;
  peer: string;
  remoteAlbumId?: string;
  remoteMappingId?: string;
  permissions: 'view' | 'contribute';
  /** State key of the utility user that OWNS the mirror album (the "host" stand-in).
   *  Its API key curates the mirror; it is never the admin key. */
  hostSlug?: string;
  /** How this share came about. Load-bearing: only 'invite' mappings may be retired by
   *  sync/invites when a peer's stand-in disappears from an album — a link-redeemed mapping
   *  never had a stand-in added to its album, so retiring those there would silently unshare
   *  every link-based album. */
  via: 'link' | 'invite';
  /** Which people at the peer this invitation names, by their user id on their own server.
   *  Sharing is per person, so an invitation always names at least one; there is no
   *  household-wide form. The member mirrors for exactly these users and follows the list as it
   *  changes — see sync/invites.syncMirrorMembers. */
  forPeerUserIds?: string[];
  /** Display name of the album's owner, captured when an invitation is detected. Link joins
   *  learn this from the redeem response instead; without it a mirror would be named after
   *  the household rather than the person who shared it. */
  albumOwnerName?: string;
  /** The album owner's user id ON THE ORIGIN — what keys their stand-in account here and on
   *  every member, so one human never becomes two picker entries. */
  albumOwnerId?: string;
  dead?: boolean;
  deadAt?: string;
  deadReason?: string;
  failCount?: number;
  localVersion?: string;
  remoteVersion?: string;
  commentCount?: number;
  remoteCommentCount?: number;
};

export type Peer = {
  pub: string;
  name: string;
  version?: string;
  /** What the peer answered on /hello, refreshed at boot. Absent = never answered (a
   *  protocol-2 peer without the route) — treat as protocol 2, no features. */
  protocol?: number;
  features?: string[];
  /** How this peer got in: an admin-approved pairing code, or a share-link redemption.
   *  Recorded at enrolment because it can never be recovered later — and it is what any
   *  future policy that treats the two differently (e.g. directory access) must gate on. */
  via: 'pair' | 'link';
  firstSeenAt: string;
  /** Where they were last reachable — hints for the next dial, never identity. */
  relayHint?: string;
  lastAddrs?: string[];
};

// `password` is transient: it exists only while the account is being provisioned, and is
// rolled to an unheld value once the API key is minted (see immich/contributors.ts).
export type Contributor = {
  userId: string;
  /** The Immich API key minted for this bot account — scoped, never the admin key. */
  apiKey: string;
  password?: string;
  avatarDone?: boolean;
  /** Public key of the peer we FIRST heard of this person through — for relayed content
   *  that is the hop, not their home. Never a routing decision; see homePeer. */
  viaPeer?: string;
  /** That person's user id ON THE PEER, for invite targets — what lets an invitation be routed
   *  to one specific person rather than the whole household. */
  peerUserId?: string;
  /**
   * The server this person actually LIVES on, set only by a directory sync — the one source that
   * proves it.
   *
   * Distinct from `viaPeer`, which is merely where we first heard of them. For relayed content
   * those differ: a photo from someone at D arrives via C, so `viaPeer` is C. Inviting them must
   * route to D, so invitability tests `homePeer`, never `viaPeer`. An account with no `homePeer`
   * is attribution-only — it can own photos, but it is not a share destination, because we have
   * no link over which to deliver one.
   */
  homePeer?: string;
};

/** This server's transport identity: a raw ed25519 keypair, base64url, 32 bytes each side.
 *  `pub` IS the iroh endpoint id and the peer-visible identity string. The envelope fields
 *  exist so a future second key type is distinguishable without sniffing byte lengths. */
export type Identity = {
  v: 1;
  alg: 'ed25519';
  pub: string;
  priv: string;
  createdAt: string;
};

export type Collections = {
  identity: Identity | null;
  peers: Peer[];
  mappings: Mapping[];
  contributors: Record<string, Contributor>;
};

const bool = (v: unknown) => (v ? 1 : 0);
const orNull = <T extends string | number>(v: T | undefined): T | null => (v === undefined ? null : v);
const jsonOrNull = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Rebuild an object from a row, dropping SQL NULLs so optional fields stay absent. */
function compact<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
  return out as T;
}

export class Store {
  db: DatabaseSync;
  state: Collections;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, 'state.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // A pre-v1 store is recognisable by its identity blob under the old kv name. v0 shipped
    // to nobody — that was the point of the v1 window — so there is deliberately NO migration:
    // refuse with instructions instead of greeting an upgrade with raw SQL errors.
    if (this.kvGet('keys'))
      throw new Error(
        'state.db is from a pre-v1 build. Stop the container, delete the data volume, and pair the servers again — pre-v1 state is not migrated.'
      );
    this.createSchema();
    let current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current === 0) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); // fresh DB: createSchema already wrote the current shape
      current = SCHEMA_VERSION;
    }
    // v1 -> v2: the store-shared-locally flag. Additive column; CREATE TABLE IF NOT EXISTS left the
    // existing table untouched, so an ALTER adds it to already-provisioned stores.
    if (current === 1) {
      this.db.exec('ALTER TABLE seen ADD COLUMN storedFull INTEGER NOT NULL DEFAULT 0');
      this.db.exec('PRAGMA user_version = 2');
      current = 2;
    }
    if (current !== SCHEMA_VERSION)
      throw new Error(
        `state.db is schema v${current}, this build writes v${SCHEMA_VERSION} — no migration exists for that jump`
      );
    this.state = {
      identity: this.kvGet('identity'),
      peers: this.loadPeers(),
      mappings: this.loadMappings(),
      contributors: this.loadContributors(),
    };
  }

  private createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        id INTEGER PRIMARY KEY,
        mapping TEXT NOT NULL,
        checksum TEXT NOT NULL,
        localAsset TEXT NOT NULL,
        originAsset TEXT,
        storedFull INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS seen_mapping_checksum ON seen (mapping, checksum);
      CREATE INDEX IF NOT EXISTS seen_localAsset ON seen (localAsset);
      CREATE TABLE IF NOT EXISTS seen_activity (tag TEXT PRIMARY KEY, mapping TEXT);
      CREATE INDEX IF NOT EXISTS seen_activity_mapping ON seen_activity (mapping);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, size INTEGER NOT NULL, lastUsed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS cache_lru ON cache (lastUsed);
    `);
    // What we have ADVERTISED to each mapping's peer. The connection proves which peer is
    // calling; this table is what decides whether that peer may read a given asset's
    // bytes. Without it the byte routes authorise identity but not entitlement, and any
    // peer that learns an asset id can read anything in the library.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS offered (
        id INTEGER PRIMARY KEY,
        mapping TEXT NOT NULL,
        asset TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS offered_mapping_asset ON offered (mapping, asset);
      CREATE INDEX IF NOT EXISTS offered_asset ON offered (asset);
      -- Album memberships THIS SIDECAR created (album id, user id). See addedRecord: it is the
      -- difference between "a human invited them" and "we put them there for attribution", and
      -- getting it wrong in the unsafe direction shares an album nobody offered.
      CREATE TABLE IF NOT EXISTS added (album TEXT NOT NULL, user TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS added_album_user ON added (album, user);
      CREATE INDEX IF NOT EXISTS added_user ON added (user);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        pub TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT,
        protocol INTEGER,
        features TEXT,
        via TEXT NOT NULL,
        firstSeenAt TEXT NOT NULL,
        relayHint TEXT,
        lastAddrs TEXT
      );
      CREATE TABLE IF NOT EXISTS mappings (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        albumId TEXT NOT NULL,
        albumName TEXT NOT NULL,
        peer TEXT NOT NULL,
        remoteAlbumId TEXT,
        remoteMappingId TEXT,
        permissions TEXT NOT NULL,
        hostSlug TEXT,
        via TEXT NOT NULL,
        forPeerUserIds TEXT,
        albumOwnerName TEXT,
        albumOwnerId TEXT,
        dead INTEGER NOT NULL DEFAULT 0,
        deadAt TEXT,
        deadReason TEXT,
        failCount INTEGER,
        localVersion TEXT,
        remoteVersion TEXT,
        commentCount INTEGER,
        remoteCommentCount INTEGER
      );
      CREATE INDEX IF NOT EXISTS mappings_peer ON mappings (peer);
      CREATE TABLE IF NOT EXISTS contributors (
        slug TEXT PRIMARY KEY,
        userId TEXT NOT NULL UNIQUE,
        apiKey TEXT NOT NULL,
        password TEXT,
        avatarDone INTEGER NOT NULL DEFAULT 0,
        viaPeer TEXT,
        peerUserId TEXT,
        homePeer TEXT
      );
    `);
  }

  /**
   * Generic kv access, for small side-tables that do not deserve a typed field on `state` —
   * the identity record, unredeemed pairing codes, and the panel settings. Deliberately
   * narrow: the three main collections have their own tables and their own save path, and
   * this must not become a second way to write them.
   */
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

  private loadPeers(): Peer[] {
    return (this.db.prepare('SELECT * FROM peers').all() as Record<string, unknown>[]).map(r => {
      const p = compact<Peer>(r);
      if (r.lastAddrs) p.lastAddrs = JSON.parse(r.lastAddrs as string);
      if (r.features) p.features = JSON.parse(r.features as string);
      return p;
    });
  }
  private loadMappings(): Mapping[] {
    return (this.db.prepare('SELECT * FROM mappings').all() as Record<string, unknown>[]).map(r => {
      const m = compact<Mapping>(r);
      m.dead = !!r.dead;
      if (!r.dead) delete m.dead;
      if (r.forPeerUserIds) m.forPeerUserIds = JSON.parse(r.forPeerUserIds as string);
      return m;
    });
  }
  private loadContributors(): Record<string, Contributor> {
    const out: Record<string, Contributor> = {};
    for (const r of this.db.prepare('SELECT * FROM contributors').all() as Record<string, unknown>[]) {
      const c = compact<Contributor & { slug: string }>(r);
      c.avatarDone = !!r.avatarDone;
      if (!r.avatarDone) delete c.avatarDone;
      const { slug, ...rest } = c;
      out[slug] = rest;
    }
    return out;
  }

  /** Persist the in-memory collections (small; one transaction, whole-collection rewrite). */
  save() {
    this.db.exec('BEGIN');
    try {
      this.kvSet('identity', this.state.identity);
      this.putCollections(this.state);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Row writes shared by save() and the v0 migration. Runs inside the caller's transaction. */
  private putCollections(cols: Collections) {
    {
      this.db.exec('DELETE FROM peers');
      const insPeer = this.db.prepare(
        'INSERT INTO peers (pub, name, version, protocol, features, via, firstSeenAt, relayHint, lastAddrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const p of cols.peers)
        insPeer.run(
          p.pub,
          p.name,
          orNull(p.version),
          orNull(p.protocol),
          jsonOrNull(p.features),
          p.via,
          p.firstSeenAt,
          orNull(p.relayHint),
          jsonOrNull(p.lastAddrs)
        );
      this.db.exec('DELETE FROM mappings');
      const insMap = this.db.prepare(
        `INSERT INTO mappings (id, role, albumId, albumName, peer, remoteAlbumId, remoteMappingId,
           permissions, hostSlug, via, forPeerUserIds, albumOwnerName, albumOwnerId,
           dead, deadAt, deadReason, failCount, localVersion, remoteVersion, commentCount, remoteCommentCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const m of cols.mappings)
        insMap.run(
          m.id,
          m.role,
          m.albumId,
          m.albumName,
          m.peer,
          orNull(m.remoteAlbumId),
          orNull(m.remoteMappingId),
          m.permissions,
          orNull(m.hostSlug),
          m.via,
          jsonOrNull(m.forPeerUserIds),
          orNull(m.albumOwnerName),
          orNull(m.albumOwnerId),
          bool(m.dead),
          orNull(m.deadAt),
          orNull(m.deadReason),
          orNull(m.failCount),
          orNull(m.localVersion),
          orNull(m.remoteVersion),
          orNull(m.commentCount),
          orNull(m.remoteCommentCount)
        );
      this.db.exec('DELETE FROM contributors');
      const insCon = this.db.prepare(
        `INSERT INTO contributors (slug, userId, apiKey, password, avatarDone, viaPeer, peerUserId, homePeer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const [slug, c] of Object.entries(cols.contributors))
        insCon.run(
          slug,
          c.userId,
          c.apiKey,
          orNull(c.password),
          bool(c.avatarDone),
          orNull(c.viaPeer),
          orNull(c.peerUserId),
          orNull(c.homePeer)
        );
    }
  }

  seenHas(mappingId: string, checksum: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM seen WHERE mapping = ? AND checksum = ?')
      .get(mappingId, checksum);
  }
  seenAdd(
    mappingId: string,
    checksum: string,
    localAssetId: string,
    originAsset?: string,
    storedFull = false
  ) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO seen (mapping, checksum, localAsset, originAsset, storedFull) VALUES (?, ?, ?, ?, ?)'
      )
      .run(mappingId, checksum, localAssetId, originAsset ?? null, storedFull ? 1 : 0);
  }
  /** The authoritative ledger entry for a local asset. A deduped proxy can carry rows
   *  from several mappings/eras; materialisation rows (with an origin asset) hold the
   *  TRUE wire identity, so they always win over watcher-push bookkeeping rows. */
  ledgerByAsset(assetId: string): SeenEntry | undefined {
    return this.db
      .prepare(
        `SELECT mapping, checksum, localAsset, originAsset FROM seen
         WHERE localAsset = ? ORDER BY (originAsset IS NOT NULL) DESC, id DESC LIMIT 1`
      )
      .get(assetId) as SeenEntry | undefined;
  }
  /** A ledger row that definitely has an origin asset: the SQL filters `originAsset IS NOT
   *  NULL`, so the type says so and callers stop re-checking what the query already guaranteed. */
  ledgerWithOrigin(assetId: string): (SeenEntry & { originAsset: string }) | undefined {
    return this.db
      .prepare(
        `SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen
         WHERE localAsset = ? AND originAsset IS NOT NULL ORDER BY id DESC LIMIT 1`
      )
      .get(assetId) as (SeenEntry & { originAsset: string }) | undefined;
  }
  seenRemoveMapping(mappingId: string) {
    this.db.prepare('DELETE FROM seen WHERE mapping = ?').run(mappingId);
  }
  seenForMapping(mappingId: string): SeenEntry[] {
    return this.db
      .prepare('SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen WHERE mapping = ?')
      .all(mappingId) as SeenEntry[];
  }
  seenRemoveEntry(mappingId: string, checksum: string) {
    this.db.prepare('DELETE FROM seen WHERE mapping = ? AND checksum = ?').run(mappingId, checksum);
  }

  // ---- offered index: which assets each mapping's peer is entitled to read ----
  offeredAdd(mappingId: string, assetIds: string[]) {
    if (!assetIds.length) return;
    const ins = this.db.prepare('INSERT OR IGNORE INTO offered (mapping, asset) VALUES (?, ?)');
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
      .prepare(`SELECT 1 FROM offered WHERE asset = ? AND mapping IN (${holes})`)
      .get(assetId, ...mappingIds);
  }
  /**
   * Revocation, per photo: drop entitlement rows for assets no longer in the album. Runs
   * whenever the watcher has the album's current contents in hand — removing a photo from a
   * shared album must also stop serving its bytes, not just stop advertising it.
   */
  offeredReconcile(mappingId: string, currentAssetIds: string[]) {
    const have = (
      this.db.prepare('SELECT asset FROM offered WHERE mapping = ?').all(mappingId) as { asset: string }[]
    ).map(r => r.asset);
    const keep = new Set(currentAssetIds);
    const gone = have.filter(a => !keep.has(a));
    if (!gone.length) return 0;
    const del = this.db.prepare('DELETE FROM offered WHERE mapping = ? AND asset = ?');
    this.db.exec('BEGIN');
    try {
      for (const a of gone) del.run(mappingId, a);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return gone.length;
  }
  offeredRemoveMapping(mappingId: string) {
    this.db.prepare('DELETE FROM offered WHERE mapping = ?').run(mappingId);
  }

  /**
   * Remember that WE added `userId` to `albumId`.
   *
   * Security-critical, and the ordering matters: callers must record BEFORE the add lands. A
   * crash between the two then leaves a row with no membership, which makes us *ignore* a real
   * invitation — visible, and the human just re-adds. Recording afterwards would leave a
   * membership with no row, which reads as human intent and shares the album with a server
   * nobody offered it to. Always fail towards under-sharing.
   */
  addedRecord(albumId: string, userId: string) {
    this.db.prepare('INSERT OR IGNORE INTO added (album, user) VALUES (?, ?)').run(albumId, userId);
  }
  /** Is this membership ours rather than a human's? */
  addedHas(albumId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM added WHERE album = ? AND user = ?').get(albumId, userId);
  }
  /**
   * Drop the record once the membership itself is gone.
   *
   * This is what keeps the table self-healing rather than sticky: without it, an album we once
   * added someone to could never afterwards be shared with them by hand, because their fresh
   * membership would still match an old row and read as ours.
   */
  addedForget(albumId: string, userId: string) {
    this.db.prepare('DELETE FROM added WHERE album = ? AND user = ?').run(albumId, userId);
  }
  /** Every album we put this user into — used when unlinking a server. */
  addedAlbumsFor(userId: string): string[] {
    return (this.db.prepare('SELECT album FROM added WHERE user = ?').all(userId) as { album: string }[]).map(
      r => r.album
    );
  }
  addedRemoveUser(userId: string) {
    this.db.prepare('DELETE FROM added WHERE user = ?').run(userId);
  }

  seenActHas(tag: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen_activity WHERE tag = ?').get(tag);
  }
  seenActAdd(tag: string, mappingId: string) {
    this.db.prepare('INSERT OR IGNORE INTO seen_activity (tag, mapping) VALUES (?, ?)').run(tag, mappingId);
  }
  /** Reclaim the activity ledger when its mapping dies — without this the table only ever grows. */
  seenActRemoveMapping(mappingId: string) {
    this.db.prepare('DELETE FROM seen_activity WHERE mapping = ?').run(mappingId);
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
