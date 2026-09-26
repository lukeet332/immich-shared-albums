/** store.rs — the raw SQLite layer: schema, migrations, and every ledger. See ARCHITECTURE.md. */
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// The shape this build writes. A store at any other version is either migrated by the numbered
/// chain below or refused — never guessed at.
pub const SCHEMA_VERSION: i64 = 4;

/// How many panel visits a queued audit line is worth before this build stops asking. Small on
/// purpose: a line whose album cannot be written is almost always one whose album is gone.
pub const TRAIL_MAX_ATTEMPTS: i64 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    #[serde(rename = "to-them")]
    ToThem,
    #[serde(rename = "from-them")]
    FromThem,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::ToThem => "to-them",
            Direction::FromThem => "from-them",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    #[serde(rename = "owner")]
    Owner,
    #[serde(rename = "member")]
    Member,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Member => "member",
        }
    }
    /// Strict, unlike the rest of the row parse: owner and member are not interchangeable
    /// (a member mirror always looks "withdrawn" to origin-side checks), so an unknown value
    /// must never silently become one of them. `None` means the row is refused at load.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Role::Owner),
            "member" => Some(Role::Member),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAlbum {
    pub name: String,
    #[serde(default)]
    pub asset_count: i64,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub owner_user_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SeenEntry {
    pub mapping: String,
    pub checksum: String,
    pub local_asset: String,
    pub origin_asset: Option<String>,
    pub stored_full: bool,
}

/// One audit line waiting for the album's owner to be present. See `sync/trail.rs`.
#[derive(Clone, Debug, PartialEq)]
pub struct TrailRow {
    pub id: i64,
    pub album_id: String,
    pub mapping_id: String,
    pub event: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub id: String,
    pub role: Role,
    pub album_id: String,
    pub album_name: String,
    pub peer: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remote_album_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remote_mapping_id: Option<String>,
    pub permissions: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub host_slug: Option<String>,
    pub via: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub for_peer_user_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub album_owner_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub album_owner_id: Option<String>,
    /// Tri-state: `None` is "never stated" (SQL NULL) and is NOT the same as `Some(false)`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub adopted: Option<bool>,
    /// Tri-state, as `adopted`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reunified: Option<bool>,
    /// Stored `NOT NULL DEFAULT 0`; loaded as `false` when falsy, so it is never `Option`.
    pub dead: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub dead_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub dead_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fail_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub local_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remote_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub comment_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub remote_comment_count: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub pub_key: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub protocol: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub features: Option<Vec<String>>,
    pub via: String,
    pub first_seen_at: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub relay_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_addrs: Option<Vec<String>>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    /// Both are `NOT NULL` in SQLite, so the empty string IS "not provisioned yet" — reachable
    /// when a mid-provisioning crash persisted the row. Every gate must ask `!x.is_empty()`;
    /// a non-empty value is the only shape that is a usable id or key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub user_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub password: Option<String>,
    pub avatar_done: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub via_peer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub peer_user_id: Option<String>,
    /// Set ONLY by a linked server's directory — the one thing that proves where a person lives.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub home_peer: Option<String>,
}

/// The transport identity, exactly as `state.ts` writes it. The JSON member names are `pub` and
/// `priv`; `pub` is a Rust keyword, so the FIELD is renamed rather than the wire member.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Identity {
    pub v: i64,
    pub alg: String,
    /// Raw 32-byte ed25519 public key, unpadded base64url — byte-for-byte the iroh endpoint id.
    #[serde(rename = "pub")]
    pub public: String,
    /// Raw 32-byte ed25519 seed, unpadded base64url.
    #[serde(rename = "priv")]
    pub private: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// Both structs hold secrets — the ed25519 seed IS this server, and a contributor's api_key can
/// act as them — so `Debug` is hand-written, like `Config`'s: `{identity:?}` must never print
/// what a log line would leak.
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("v", &self.v)
            .field("alg", &self.alg)
            .field("public", &self.public)
            .field("private", &"[REDACTED]")
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl std::fmt::Debug for Contributor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Contributor")
            .field("user_id", &self.user_id)
            // Empty = no key, so there is nothing to redact; a real key is never printed.
            .field(
                "api_key",
                if self.api_key.is_empty() {
                    &""
                } else {
                    &"[REDACTED]"
                },
            )
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("avatar_done", &self.avatar_done)
            .field("via_peer", &self.via_peer)
            .field("peer_user_id", &self.peer_user_id)
            .field("home_peer", &self.home_peer)
            .finish()
    }
}

/// The three collections `save()` rewrites wholesale. The ledgers are written per-row instead —
/// two disciplines, kept apart on purpose so the crash windows stay as the TypeScript has them.
#[derive(Default)]
pub struct Collections {
    pub peers: Vec<Peer>,
    pub mappings: Vec<Mapping>,
    pub contributors: std::collections::HashMap<String, Contributor>,
    pub identity: Option<Identity>,
}

pub struct Store {
    conn: Mutex<Connection>,
    pub state: Mutex<Collections>,
}

impl Store {
    pub fn open(data_dir: &str) -> Result<Self, StoreError> {
        if !Path::new(data_dir).exists() {
            std::fs::create_dir_all(data_dir).map_err(|e| StoreError::Io(e.to_string()))?;
        }
        let conn = Connection::open(Path::new(data_dir).join("state.db"))
            .map_err(|e| StoreError::Sqlite(e.to_string()))?;
        let mut store = Store {
            conn: Mutex::new(conn),
            state: Mutex::new(Collections::default()),
        };
        store.init()?;
        Ok(store)
    }

    /// An in-memory store, for tests. Same schema and migration chain as a real one.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory().map_err(|e| StoreError::Sqlite(e.to_string()))?;
        let mut store = Store {
            conn: Mutex::new(conn),
            state: Mutex::new(Collections::default()),
        };
        store.init()?;
        Ok(store)
    }

    fn init(&mut self) -> Result<(), StoreError> {
        // ONE lock for the whole of init, handed to free functions that take `&Connection`.
        // Locking per helper instead deadlocks: `std::sync::Mutex` is not reentrant.
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        refuse_pre_v1(&conn)?;
        let mut current = user_version(&conn)?;
        create_schema(&conn)?;
        if current == 0 {
            set_user_version(&conn, SCHEMA_VERSION)?;
            current = SCHEMA_VERSION;
        }
        // v1 -> v2: the store-shared-locally flag. Additive column; create_schema's
        // IF NOT EXISTS left an existing table untouched, so an ALTER adds it.
        if current == 1 {
            add_column_if_missing(&conn, "seen", "storedFull", "INTEGER NOT NULL DEFAULT 0")?;
            set_user_version(&conn, 2)?;
            current = 2;
        }
        // v2 -> v3: the two reunification facts. Nullable and unset for every mapping that already
        // exists, because neither is true of a share made the ordinary way.
        if current == 2 {
            add_column_if_missing(&conn, "mappings", "adopted", "INTEGER")?;
            add_column_if_missing(&conn, "mappings", "reunified", "INTEGER")?;
            set_user_version(&conn, 3)?;
            current = 3;
        }
        // v3 -> v4: the two DIRECTIONS of the album index get their own rows. They were keyed by
        // peer alone, so one peer's key held both what we OFFER them and what we RECEIVED from them.
        // A row cannot be assigned a direction after the fact and both halves rebuild from living
        // sources, so the migration clears rather than guesses.
        if current == 3 {
            add_column_if_missing(
                &conn,
                "published_albums",
                "direction",
                "TEXT NOT NULL DEFAULT 'to-them'",
            )?;
            conn.execute_batch("DELETE FROM published_albums;")?;
            set_user_version(&conn, 4)?;
            current = 4;
        }
        if current != SCHEMA_VERSION {
            return Err(StoreError::SchemaVersion {
                found: current,
                expected: SCHEMA_VERSION,
            });
        }
        // Indexes naming a MIGRATED column belong after the chain: a fresh table has the column,
        // a migrated one gains it in the branch above, and IF NOT EXISTS runs either way.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS published_albums_peer ON published_albums (peer, direction);
             CREATE INDEX IF NOT EXISTS seen_checksum ON seen (checksum);",
        )?;
        drop(conn);
        self.load_collections()?;
        Ok(())
    }

    pub fn user_version(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock().unwrap();
        user_version(&conn)
    }

    // ---- kv ----

    pub fn kv(&self, name: &str) -> Result<Option<serde_json::Value>, StoreError> {
        let raw = self.kv_raw(name)?;
        Ok(raw.and_then(|v| serde_json::from_str(&v).ok()))
    }

    fn kv_raw(&self, name: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT value FROM kv WHERE name = ?1", [name], |r| r.get(0))
            .optional()?)
    }

    pub fn kv_set(&self, name: &str, value: &serde_json::Value) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO kv (name, value) VALUES (?1, ?2)",
            rusqlite::params![name, value.to_string()],
        )?;
        Ok(())
    }

    // ---- the seen ledger ----

    pub fn seen_has(&self, mapping: &str, checksum: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM seen WHERE mapping = ?1 AND checksum = ?2",
            rusqlite::params![mapping, checksum],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// `INSERT OR IGNORE`: re-adding never upgrades `storedFull`. Upgrade is remove-then-add.
    pub fn seen_add(
        &self,
        mapping: &str,
        checksum: &str,
        local_asset: &str,
        origin_asset: Option<&str>,
        stored_full: bool,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO seen (mapping, checksum, localAsset, originAsset, storedFull)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                mapping,
                checksum,
                local_asset,
                origin_asset,
                stored_full as i64
            ],
        )?;
        Ok(())
    }

    /// The authoritative row for a local asset. Two rows per asset are normal (a watcher-push row
    /// and a materialisation row), so the ordering is the contract: a row carrying an origin wins,
    /// and among equals the newest wins.
    pub fn ledger_by_asset(&self, asset_id: &str) -> Result<Option<SeenEntry>, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen
                 WHERE localAsset = ?1
                 ORDER BY (originAsset IS NOT NULL) DESC, id DESC LIMIT 1",
                [asset_id],
                row_to_seen,
            )
            .optional()?)
    }

    /// As `ledger_by_asset`, but only a row that can be resolved to a source. A bookkeeping row
    /// with no origin cannot name what to fetch, so callers must not see one.
    pub fn ledger_with_origin(&self, asset_id: &str) -> Result<Option<SeenEntry>, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen
                 WHERE localAsset = ?1 AND originAsset IS NOT NULL
                 ORDER BY id DESC LIMIT 1",
                [asset_id],
                row_to_seen,
            )
            .optional()?)
    }

    pub fn seen_for_mapping(&self, mapping: &str) -> Result<Vec<SeenEntry>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen
             WHERE mapping = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([mapping], row_to_seen)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// How many of a mapping's ledger rows name a SOURCE — the stub half of a mirror. The
    /// watcher's unchanged-album handshake wants exactly this plus `offered_count`: rows without
    /// an origin are this side's own pushed photos, which `offered` already counts.
    pub fn seen_origin_count(&self, mapping: &str) -> Result<usize, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM seen WHERE mapping = ?1 AND originAsset IS NOT NULL",
            [mapping],
            |r| r.get::<_, i64>(0).map(|n| n as usize),
        )?)
    }

    /// Every row that names a SOURCE — the stub half, across all mappings. The orphan reclaimer
    /// walks these to collect stubs whose mapping is gone; the index on `originAsset`-bearing
    /// lookups is the mapping index, so this is a full scan of one table, bounded by the reclaimer's
    /// batch and its interval.
    pub fn seen_origin_rows(&self) -> Result<Vec<SeenEntry>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen
             WHERE originAsset IS NOT NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([], row_to_seen)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn seen_for_checksum(&self, checksum: &str) -> Result<Vec<SeenEntry>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen
             WHERE checksum = ?1 ORDER BY id",
        )?;
        let rows = stmt.query_map([checksum], row_to_seen)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Forget the proxies a mapping materialised. A stored-FULL copy KEEPS its row: the row is what
    /// still marks those bytes as a copy taken from a share rather than a household photo, so the
    /// interceptor serves them from the local file instead of chaining to a peer that no longer
    /// shares them. See `sync/leave.rs`.
    pub fn seen_forget_proxies(&self, mapping: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM seen WHERE mapping = ?1 AND storedFull = 0",
            [mapping],
        )?;
        Ok(())
    }

    /// Forget EVERY row a mapping owns, stored-FULL copies included. For when the assets themselves
    /// are gone — unlinking deletes the peer's accounts, and `force: true` takes their assets with
    /// them, so a row left behind would claim bytes this household no longer holds.
    pub fn seen_forget_mapping(&self, mapping: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM seen WHERE mapping = ?1", [mapping])?;
        Ok(())
    }

    pub fn seen_remove_entry(&self, mapping: &str, checksum: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM seen WHERE mapping = ?1 AND checksum = ?2",
            rusqlite::params![mapping, checksum],
        )?;
        Ok(())
    }

    // ---- the activity ledger ----

    pub fn seen_act_has(&self, tag: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM seen_activity WHERE tag = ?1",
            [tag],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn seen_act_add(&self, tag: &str, mapping: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO seen_activity (tag, mapping) VALUES (?1, ?2)",
            rusqlite::params![tag, mapping],
        )?;
        Ok(())
    }

    pub fn seen_act_remove_mapping(&self, mapping: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM seen_activity WHERE mapping = ?1", [mapping])?;
        Ok(())
    }

    // ---- the trail that waits for its album's owner ----

    /// Queue one line. Returns its row id, which is what makes the eventual line unique: the same
    /// album can gain two joins, and `audit_line`'s tag is keyed by event AND album.
    pub fn trail_pending_add(
        &self,
        album_id: &str,
        mapping_id: &str,
        event: &str,
        text: &str,
    ) -> Result<i64, StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO trail_pending (albumId, mappingId, event, text, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![album_id, mapping_id, event, text, crate::config::iso_now()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Everything waiting, oldest first. Read in full because it is bounded by human-scale events
    /// (one row per join or leave) and drained on a person's visit.
    pub fn trail_pending_all(&self) -> Result<Vec<TrailRow>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, albumId, mappingId, event, text FROM trail_pending ORDER BY id")?;
        let rows = stmt.query_map([], |r| {
            Ok(TrailRow {
                id: r.get(0)?,
                album_id: r.get(1)?,
                mapping_id: r.get(2)?,
                event: r.get(3)?,
                text: r.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Count one failed attempt. Returns whether the line has now been given up on — an album that
    /// is gone (deleted, or no longer visible to its owner) must not be asked about on every visit
    /// for the rest of the install's life.
    pub fn trail_pending_bump(&self, id: i64) -> Result<bool, StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE trail_pending SET attempts = attempts + 1 WHERE id = ?1",
            [id],
        )?;
        let attempts: i64 = conn.query_row(
            "SELECT attempts FROM trail_pending WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        if attempts >= TRAIL_MAX_ATTEMPTS {
            conn.execute("DELETE FROM trail_pending WHERE id = ?1", [id])?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn trail_pending_remove(&self, id: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM trail_pending WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn trail_pending_count(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM trail_pending", [], |r| r.get(0))?)
    }

    // ---- entitlement ----

    pub fn offered_add(&self, mapping: &str, asset_ids: &[String]) -> Result<(), StoreError> {
        if asset_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare("INSERT OR IGNORE INTO offered (mapping, asset) VALUES (?1, ?2)")?;
            for asset in asset_ids {
                stmt.execute(rusqlite::params![mapping, asset])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn offered_allows(&self, mappings: &[String], asset_id: &str) -> Result<bool, StoreError> {
        if mappings.is_empty() {
            return Ok(false);
        }
        let conn = self.conn.lock().unwrap();
        for mapping in mappings {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM offered WHERE mapping = ?1 AND asset = ?2",
                rusqlite::params![mapping, asset_id],
                |r| r.get(0),
            )?;
            if n > 0 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The mappings this asset was OFFERED to — the albums to tell "look again" when the asset's
    /// own metadata is edited, since no album row moves and the version handshake cannot see it.
    pub fn offered_mappings_for(&self, asset_id: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT mapping FROM offered WHERE asset = ?1")?;
        let rows = stmt.query_map([asset_id], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Real revocation: an asset that left the album loses its row. Returns the revoked ASSET ids,
    /// because they are exactly the push's removals: the origin's stub for a deleted contribution
    /// has no other way to learn its source is gone (a push carries only adds unless we say so).
    pub fn offered_reconcile(
        &self,
        mapping: &str,
        current_asset_ids: &[String],
    ) -> Result<Vec<String>, StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: std::collections::HashSet<&str> =
            current_asset_ids.iter().map(String::as_str).collect();
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT asset FROM offered WHERE mapping = ?1")?;
            let rows = stmt.query_map([mapping], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut revoked = Vec::new();
        for asset in existing {
            // Set membership, not a scan: this runs per album per cycle, and albums run to
            // thousands of assets.
            if !current.contains(asset.as_str()) {
                tx.execute(
                    "DELETE FROM offered WHERE mapping = ?1 AND asset = ?2",
                    rusqlite::params![mapping, asset],
                )?;
                revoked.push(asset);
            }
        }
        tx.commit()?;
        Ok(revoked)
    }

    /// How many assets this mapping still offers its peer — the contribution half of what a mirror
    /// album should hold (the stub half is the ledger), and the cheap tell that a member deleted
    /// their own contribution: the album's count shrank but nothing bumped `updatedAt`.
    pub fn offered_count(&self, mapping: &str) -> Result<usize, StoreError> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM offered WHERE mapping = ?1",
            [mapping],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    pub fn offered_remove_mapping(&self, mapping: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM offered WHERE mapping = ?1", [mapping])?;
        Ok(())
    }

    // ---- added: memberships WE created ----

    /// Records that *we* added this membership. MUST be called before the add lands: a crash in
    /// between then leaves a record with no membership (we ignore a real invitation) rather than a
    /// membership with no record (which reads as human intent and shares an album nobody offered).
    pub fn added_record(&self, album: &str, user: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO added (album, user) VALUES (?1, ?2)",
            rusqlite::params![album, user],
        )?;
        Ok(())
    }

    pub fn added_has(&self, album: &str, user: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM added WHERE album = ?1 AND user = ?2",
            rusqlite::params![album, user],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn added_forget(&self, album: &str, user: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM added WHERE album = ?1 AND user = ?2",
            rusqlite::params![album, user],
        )?;
        Ok(())
    }

    pub fn added_albums_for(&self, user: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT album FROM added WHERE user = ?1")?;
        let rows = stmt.query_map([user], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn added_remove_user(&self, user: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM added WHERE user = ?1", [user])?;
        Ok(())
    }

    // ---- the byte cache's accounting ----

    pub fn cache_touch(&self, key: &str) -> Result<bool, StoreError> {
        let conn = self.conn.lock().unwrap();
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM cache WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            return Ok(false);
        }
        conn.execute(
            "UPDATE cache SET lastUsed = ?1 WHERE key = ?2",
            rusqlite::params![now_ms(), key],
        )?;
        Ok(true)
    }

    pub fn cache_put(&self, key: &str, size: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO cache (key, size, lastUsed) VALUES (?1, ?2, ?3)",
            rusqlite::params![key, size, now_ms()],
        )?;
        Ok(())
    }

    pub fn cache_total(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT COALESCE(SUM(size), 0) FROM cache", [], |r| r.get(0))?)
    }

    pub fn cache_evict_oldest(&self) -> Result<Option<(String, i64)>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT key, size FROM cache ORDER BY lastUsed ASC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((key, size)) = &row {
            conn.execute("DELETE FROM cache WHERE key = ?1", [key])?;
            return Ok(Some((key.clone(), *size)));
        }
        Ok(None)
    }

    // ---- the album index ----

    pub fn published_albums_set(
        &self,
        peer: &str,
        direction: Direction,
        owner_user_id: &str,
        albums: &[OwnedAlbum],
    ) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM published_albums WHERE peer = ?1 AND direction = ?2 AND ownerUserId = ?3",
            rusqlite::params![peer, direction.as_str(), owner_user_id],
        )?;
        insert_published(&tx, peer, direction, owner_user_id, albums)?;
        tx.commit()?;
        Ok(())
    }

    /// Replace a peer's WHOLE index for one direction. Silence about an owner clears them, which
    /// is how a withdrawn album disappears.
    pub fn published_albums_replace_peer(
        &self,
        peer: &str,
        direction: Direction,
        albums: &[OwnedAlbum],
    ) -> Result<(), StoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM published_albums WHERE peer = ?1 AND direction = ?2",
            rusqlite::params![peer, direction.as_str()],
        )?;
        let by_owner = group_by_owner(albums);
        for (owner, group) in by_owner {
            insert_published(&tx, peer, direction, &owner, &group)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn published_albums_for(
        &self,
        peer: &str,
        direction: Direction,
    ) -> Result<Vec<OwnedAlbum>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT name, assetCount, startDate, endDate, ownerName, ownerUserId
             FROM published_albums WHERE peer = ?1 AND direction = ?2 ORDER BY name",
        )?;
        let rows = stmt.query_map(rusqlite::params![peer, direction.as_str()], |r| {
            Ok(OwnedAlbum {
                name: r.get(0)?,
                asset_count: r.get(1)?,
                start_date: r.get(2)?,
                end_date: r.get(3)?,
                owner_name: r.get(4)?,
                owner_user_id: r.get(5).ok(),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ---- collections ----

    fn load_collections(&self) -> Result<(), StoreError> {
        let peers: Vec<Peer> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT pub, name, version, protocol, features, via, firstSeenAt, relayHint, lastAddrs FROM peers",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(Peer {
                    pub_key: r.get(0)?,
                    name: r.get(1)?,
                    version: r.get(2)?,
                    protocol: r.get(3)?,
                    features: r
                        .get::<_, Option<String>>(4)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    via: r.get(5)?,
                    first_seen_at: r.get(6)?,
                    relay_hint: r.get(7)?,
                    last_addrs: r
                        .get::<_, Option<String>>(8)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                })
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mappings: Vec<Mapping> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, role, albumId, albumName, peer, remoteAlbumId, remoteMappingId, permissions,
                        hostSlug, via, forPeerUserIds, albumOwnerName, albumOwnerId, adopted, reunified,
                        dead, deadAt, deadReason, failCount, localVersion, remoteVersion, commentCount,
                        remoteCommentCount FROM mappings",
            )?;
            let rows = stmt.query_map([], |r| {
                let id: String = r.get(0)?;
                let role: String = r.get(1)?;
                let Some(role) = Role::parse(&role) else {
                    // Fail towards under-sharing: a mapping that cannot be classified is not
                    // loaded, so nothing origin-side ever reads it as an owner mapping.
                    crate::log!(
                        "mappings row {id} carries role \"{role}\" — not \"owner\" or \"member\"; refusing to load it"
                    );
                    return Err(rusqlite::Error::InvalidColumnType(
                        1,
                        "role".into(),
                        rusqlite::types::Type::Text,
                    ));
                };
                Ok(Mapping {
                    id,
                    role,
                    album_id: r.get(2)?,
                    album_name: r.get(3)?,
                    peer: r.get(4)?,
                    remote_album_id: r.get(5)?,
                    remote_mapping_id: r.get(6)?,
                    permissions: r.get(7)?,
                    host_slug: r.get(8)?,
                    via: r.get(9)?,
                    for_peer_user_ids: r
                        .get::<_, Option<String>>(10)?
                        .and_then(|s| serde_json::from_str(&s).ok()),
                    album_owner_name: r.get(11)?,
                    album_owner_id: r.get(12)?,
                    // Tri-state: NULL stays None, and 0/1 map to Some(false)/Some(true).
                    adopted: r.get::<_, Option<i64>>(13)?.map(|v| v != 0),
                    reunified: r.get::<_, Option<i64>>(14)?.map(|v| v != 0),
                    dead: r.get::<_, i64>(15)? != 0,
                    dead_at: r.get(16)?,
                    dead_reason: r.get(17)?,
                    fail_count: r.get(18)?,
                    local_version: r.get(19)?,
                    remote_version: r.get(20)?,
                    comment_count: r.get(21)?,
                    remote_comment_count: r.get(22)?,
                })
            })?;
            // A row that failed to classify (or decode) must FAIL THE LOAD, never silently
            // vanish: the row is absent from memory, and the next `save()` rewrites this table
            // from memory — a dropped row here would be DELETED there, and a mapping the
            // sidecar can no longer see is a live share nobody can withdraw. Same doctrine as
            // the version refusal: migrated or refused, never guessed at.
            rows.collect::<Result<Vec<Mapping>, _>>().map_err(|e| {
                StoreError::Corrupt(format!("a mappings row could not be loaded ({e})"))
            })?
        };

        let contributors: std::collections::HashMap<String, Contributor> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT slug, userId, apiKey, password, avatarDone, viaPeer, peerUserId, homePeer FROM contributors",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Contributor {
                        user_id: r.get(1)?,
                        api_key: r.get(2)?,
                        password: r.get(3)?,
                        avatar_done: r.get::<_, i64>(4)? != 0,
                        via_peer: r.get(5)?,
                        peer_user_id: r.get(6)?,
                        home_peer: r.get(7)?,
                    },
                ))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let identity: Option<Identity> = self
            .kv_raw("identity")?
            .and_then(|raw| serde_json::from_str(&raw).ok());

        let mut state = self.state.lock().unwrap();
        *state = Collections {
            peers,
            mappings,
            contributors,
            identity,
        };
        Ok(())
    }

    /// One transaction: the identity row and a wholesale rewrite of peers, mappings and
    /// contributors. It does NOT touch seen, seen_activity, offered, added, cache or
    /// published_albums — those are written per-row as they happen.
    pub fn save(&self) -> Result<(), StoreError> {
        // BOUNDED, and loud on failure. Both locks here are non-reentrant `std::sync::Mutex`es, so
        // a caller that already holds one through `collections()` deadlocks against itself — and a
        // deadlocked sidecar simply stops answering, which reads as a mysterious hang rather than a
        // bug. Normal contention clears in microseconds, so a wait that outlives the bound was
        // never going to succeed; naming it turns a silent hang into a named failure. The second
        // lock is the worse one: a caller blocked there already holds `state`, so every other task
        // queues behind it and the whole sidecar goes quiet.
        let state = bounded_lock(&self.state, "nothing yet", "the state lock");
        let mut conn = bounded_lock(&self.conn, "the state lock", "the database");
        let tx = conn.transaction()?;
        if let Some(identity) = &state.identity {
            tx.execute(
                "INSERT OR REPLACE INTO kv (name, value) VALUES ('identity', ?1)",
                [serde_json::to_string(identity)
                    .expect("Identity is a plain struct: serialization cannot fail")],
            )?;
        }
        tx.execute("DELETE FROM peers", [])?;
        for p in &state.peers {
            tx.execute(
                "INSERT INTO peers (pub, name, version, protocol, features, via, firstSeenAt, relayHint, lastAddrs)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    p.pub_key, p.name, p.version, p.protocol,
                    p.features.as_ref().map(|f| serde_json::to_string(f).unwrap_or_default()),
                    p.via, p.first_seen_at, p.relay_hint,
                    p.last_addrs.as_ref().map(|a| serde_json::to_string(a).unwrap_or_default()),
                ],
            )?;
        }
        tx.execute("DELETE FROM mappings", [])?;
        for m in &state.mappings {
            tx.execute(
                "INSERT INTO mappings (id, role, albumId, albumName, peer, remoteAlbumId, remoteMappingId,
                  permissions, hostSlug, via, forPeerUserIds, albumOwnerName, albumOwnerId, adopted,
                  reunified, dead, deadAt, deadReason, failCount, localVersion, remoteVersion,
                  commentCount, remoteCommentCount)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
                rusqlite::params![
                    m.id, m.role.as_str(), m.album_id, m.album_name, m.peer,
                    m.remote_album_id, m.remote_mapping_id, m.permissions, m.host_slug, m.via,
                    m.for_peer_user_ids.as_ref().map(|v| serde_json::to_string(v).unwrap_or_default()),
                    m.album_owner_name, m.album_owner_id,
                    // Tri-state written as NULL, never 0.
                    m.adopted.map(|b| b as i64),
                    m.reunified.map(|b| b as i64),
                    m.dead as i64, m.dead_at, m.dead_reason, m.fail_count,
                    m.local_version, m.remote_version, m.comment_count, m.remote_comment_count,
                ],
            )?;
        }
        tx.execute("DELETE FROM contributors", [])?;
        for (slug, c) in &state.contributors {
            tx.execute(
                "INSERT INTO contributors (slug, userId, apiKey, password, avatarDone, viaPeer, peerUserId, homePeer)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                rusqlite::params![
                    slug,
                    c.user_id.clone(),
                    c.api_key.clone(),
                    c.password, c.avatar_done as i64, c.via_peer, c.peer_user_id, c.home_peer,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

/// A pre-v1 store is refused with an actionable message rather than migrated: it holds nothing
/// worth keeping and the old shape cannot be reconstructed faithfully.
fn refuse_pre_v1(conn: &Connection) -> Result<(), StoreError> {
    let has_keys: Option<String> = conn
        .query_row("SELECT value FROM kv WHERE name = 'keys'", [], |r| r.get(0))
        .optional()?;
    if has_keys.is_some() {
        return Err(StoreError::PreV1);
    }
    Ok(())
}

fn user_version(conn: &Connection) -> Result<i64, StoreError> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

fn set_user_version(conn: &Connection, v: i64) -> Result<(), StoreError> {
    conn.execute_batch(&format!("PRAGMA user_version = {v};"))?;
    Ok(())
}

/// Exists because `create_schema` runs BEFORE the migration chain: on an already-provisioned store
/// the migrated column may already be present, and a bare ALTER dies with "duplicate column name".
/// Re-running the chain on a migrated store must be a no-op.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let existing: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    if !existing.iter().any(|c| c == column) {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))?;
    }
    Ok(())
}

fn create_schema(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "
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
        -- An audit line we could not write yet: the event happened while the album's owner was not
        -- here to authorise it (our bot can only be put on THEIR album by THEM), so it waits for
        -- their next visit. Additive, so no schema bump: an older build ignores the table.
        CREATE TABLE IF NOT EXISTS trail_pending (
          id INTEGER PRIMARY KEY,
          albumId TEXT NOT NULL,
          mappingId TEXT NOT NULL,
          event TEXT NOT NULL,
          text TEXT NOT NULL,
          at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS trail_pending_album ON trail_pending (albumId);
        CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, size INTEGER NOT NULL, lastUsed INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS cache_lru ON cache (lastUsed);
        CREATE TABLE IF NOT EXISTS offered (
          id INTEGER PRIMARY KEY,
          mapping TEXT NOT NULL,
          asset TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS offered_mapping_asset ON offered (mapping, asset);
        CREATE INDEX IF NOT EXISTS offered_asset ON offered (asset);
        CREATE TABLE IF NOT EXISTS added (album TEXT NOT NULL, user TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS added_album_user ON added (album, user);
        CREATE INDEX IF NOT EXISTS added_user ON added (user);
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
          adopted INTEGER,
          reunified INTEGER,
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
        CREATE TABLE IF NOT EXISTS published_albums (
          peer TEXT NOT NULL,
          direction TEXT NOT NULL,
          ownerUserId TEXT NOT NULL,
          name TEXT NOT NULL,
          assetCount INTEGER NOT NULL DEFAULT 0,
          startDate TEXT,
          endDate TEXT,
          ownerName TEXT NOT NULL DEFAULT ''
        );
        ",
    )?;
    Ok(())
}

fn row_to_seen(r: &rusqlite::Row<'_>) -> rusqlite::Result<SeenEntry> {
    Ok(SeenEntry {
        mapping: r.get(0)?,
        checksum: r.get(1)?,
        local_asset: r.get(2)?,
        origin_asset: r.get(3)?,
        stored_full: r.get::<_, i64>(4)? != 0,
    })
}

fn insert_published(
    tx: &rusqlite::Transaction<'_>,
    peer: &str,
    direction: Direction,
    owner_user_id: &str,
    albums: &[OwnedAlbum],
) -> Result<(), StoreError> {
    for a in albums {
        tx.execute(
            "INSERT INTO published_albums (peer, direction, ownerUserId, name, assetCount, startDate, endDate, ownerName)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                peer, direction.as_str(), owner_user_id, a.name, a.asset_count,
                a.start_date, a.end_date, a.owner_name,
            ],
        )?;
    }
    Ok(())
}

fn group_by_owner(albums: &[OwnedAlbum]) -> Vec<(String, Vec<OwnedAlbum>)> {
    // First-seen owner order is preserved (a bare HashMap would shuffle owners between runs),
    // without the O(n²) rescan the earlier list version cost.
    let mut order: Vec<String> = Vec::new();
    let mut groups: std::collections::HashMap<String, Vec<OwnedAlbum>> =
        std::collections::HashMap::new();
    for a in albums {
        let owner = a.owner_user_id.clone().unwrap_or_default();
        if !groups.contains_key(&owner) {
            order.push(owner.clone());
        }
        groups.entry(owner).or_default().push(a.clone());
    }
    order
        .into_iter()
        .map(|owner| {
            let group = groups.remove(&owner).unwrap_or_default();
            (owner, group)
        })
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug)]
pub enum StoreError {
    Sqlite(String),
    Io(String),
    PreV1,
    Corrupt(String),
    SchemaVersion { found: i64, expected: i64 },
}

/// Take a non-reentrant lock, refusing to spin forever: once the wait outlives `SAVE_LOCK_WAIT`
/// the failure is NAMED (a self-deadlock or severe contention — the deadlock class this port has
/// hit repeatedly), and the ordinary blocking lock is taken as the log says, so the caller either
/// proceeds or blocks visibly instead of spinning silently for ever. Poison is recovered because a
/// poisoned lock here means a task panicked mid-save; the last committed data still stands and
/// refusing it would lose every later write.
fn bounded_lock<'a, T>(
    mutex: &'a Mutex<T>,
    held: &str,
    waiting_for: &str,
) -> std::sync::MutexGuard<'a, T> {
    const SAVE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(3);
    const RETRY_SLEEP: std::time::Duration = std::time::Duration::from_millis(5);
    let deadline = std::time::Instant::now() + SAVE_LOCK_WAIT;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return guard,
            Err(std::sync::TryLockError::Poisoned(e)) => return e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    crate::log!(
                        "SAVE blocked {SAVE_LOCK_WAIT:?} waiting for {waiting_for} while holding {held} — every other task is blocked behind this one. Blocking as normal, but this is the bug."
                    );
                    return mutex.lock().unwrap_or_else(|e| e.into_inner());
                }
                std::thread::sleep(RETRY_SLEEP);
            }
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "sqlite: {e}"),
            StoreError::Io(e) => write!(f, "io: {e}"),
            StoreError::PreV1 => write!(
                f,
                "state.db is from a pre-v1 build. Stop the container, delete the data volume, \
                 and pair the servers again — pre-v1 state is not migrated."
            ),
            StoreError::Corrupt(e) => write!(
                f,
                "state.db holds a row this build refuses to load ({e}) — it will not be rewritten \
                 behind your back. Restore the volume or delete it and pair the servers again."
            ),
            StoreError::SchemaVersion { found, expected } => write!(
                f,
                "state.db is schema v{found}, this build writes v{expected} — no migration exists for that jump"
            ),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn store() -> Store {
        Store::open_in_memory().expect("in-memory store")
    }

    #[test]
    fn a_fresh_store_is_stamped_with_the_schema_version() {
        let s = store();
        assert_eq!(s.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(SCHEMA_VERSION, 4);
    }

    #[test]
    fn identity_round_trips_as_v1_ed25519_base64url() {
        let s = store();
        let id = Identity {
            v: 1,
            alg: "ed25519".into(),
            public: "A".repeat(43),
            private: "B".repeat(43),
            created_at: "2026-09-21T00:00:00.000Z".into(),
        };
        s.state.lock().unwrap().identity = Some(id.clone());
        s.save().unwrap();
        let raw = s.kv_raw("identity").unwrap().expect("identity row");
        // The row name is `identity`, NOT `state.identity` — the JS property name differs.
        assert!(raw.contains("\"alg\":\"ed25519\""));
        let parsed: Identity = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn a_pre_v1_store_is_refused_with_an_actionable_message() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        conn.execute("INSERT INTO kv (name, value) VALUES ('keys', '{}')", [])
            .unwrap();
        drop(conn);
        // Build the store over the same file-backed path to exercise init().
        let dir = std::env::temp_dir().join(format!("isa-prev1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            let c = Connection::open(dir.join("state.db")).unwrap();
            c.execute_batch("CREATE TABLE kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);")
                .unwrap();
            c.execute("INSERT INTO kv (name, value) VALUES ('keys', '{}')", [])
                .unwrap();
        }
        match Store::open(dir.to_str().unwrap()).err() {
            Some(StoreError::PreV1) => {}
            other => panic!("expected a PreV1 refusal, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_schema_version_is_refused_not_guessed() {
        let dir = std::env::temp_dir().join(format!("isa-v99-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            let c = Connection::open(dir.join("state.db")).unwrap();
            c.execute_batch("PRAGMA user_version = 99;").unwrap();
        }
        match Store::open(dir.to_str().unwrap()).err() {
            Some(StoreError::SchemaVersion {
                found: 99,
                expected: 4,
            }) => {}
            other => panic!("expected a v99 refusal, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mappings_row_that_cannot_be_classified_refuses_the_store_instead_of_vanishing() {
        // A dropped row would be DELETED by the next save()'s wholesale rewrite: a mapping the
        // sidecar can no longer see is a live share nobody can withdraw. Refuse, like PreV1.
        let dir = std::env::temp_dir().join(format!("isa-role-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = Store::open(dir.to_str().unwrap()).unwrap();
            drop(store);
            let c = Connection::open(dir.join("state.db")).unwrap();
            c.execute(
                "INSERT INTO mappings (id, role, albumId, albumName, peer, permissions, via)
                 VALUES ('m-corrupt', 'admin', 'a1', 'A', 'peer-1', 'view', 'invite')",
                [],
            )
            .unwrap();
        }
        match Store::open(dir.to_str().unwrap()).err() {
            Some(StoreError::Corrupt(_)) => {}
            other => panic!("expected a Corrupt refusal, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_by_asset_prefers_the_row_that_can_be_resolved_to_a_source() {
        let s = store();
        // The watcher's bookkeeping row carries no origin. Two rows for one local asset are normal
        // but MUST differ in (mapping, checksum) — that pair is uniquely indexed, so a second write
        // with the same pair is ignored rather than stored.
        s.seen_add("m1", "sum-a", "asset-1", None, false).unwrap();
        assert!(s.ledger_with_origin("asset-1").unwrap().is_none());
        // The materialiser's row, under its own mapping, is the one that can be resolved to a source.
        s.seen_add("m2", "sum-b", "asset-1", Some("origin-1"), false)
            .unwrap();
        let best = s.ledger_by_asset("asset-1").unwrap().unwrap();
        assert_eq!(best.origin_asset.as_deref(), Some("origin-1"));
        assert_eq!(
            s.ledger_with_origin("asset-1")
                .unwrap()
                .unwrap()
                .origin_asset
                .as_deref(),
            Some("origin-1")
        );
    }

    #[test]
    fn seen_add_never_upgrades_stored_full() {
        let s = store();
        s.seen_add("m1", "sum", "asset", Some("origin"), false)
            .unwrap();
        s.seen_add("m1", "sum", "asset", Some("origin"), true)
            .unwrap();
        // INSERT OR IGNORE: the existing row stands. Upgrade is remove-then-add.
        assert!(!s.ledger_by_asset("asset").unwrap().unwrap().stored_full);
        s.seen_remove_entry("m1", "sum").unwrap();
        s.seen_add("m1", "sum", "asset", Some("origin"), true)
            .unwrap();
        assert!(s.ledger_by_asset("asset").unwrap().unwrap().stored_full);
    }

    #[test]
    fn the_stub_count_names_sources_not_bookkeeping_rows() {
        let s = store();
        // A pushed contribution has no origin; a stub does. The handshake counts only the stubs.
        s.seen_add("m1", "pushed-sum", "ours", None, false).unwrap();
        assert_eq!(s.seen_origin_count("m1").unwrap(), 0);
        s.seen_add("m1", "stub-sum", "stub", Some("origin-a"), false)
            .unwrap();
        s.seen_add("m1", "full-sum", "full", Some("origin-b"), true)
            .unwrap();
        assert_eq!(s.seen_origin_count("m1").unwrap(), 2);
        // A stored-FULL copy still names its source: it counts, it is not a contribution.
        assert_eq!(s.seen_for_mapping("m1").unwrap().len(), 3);
    }

    #[test]
    fn a_role_that_is_neither_owner_nor_member_is_refused_not_guessed() {
        // The owner/member distinction is load-bearing: a member mirror must never silently
        // become an owner mapping, or retiring it kills a live album.
        assert_eq!(Role::parse("owner"), Some(Role::Owner));
        assert_eq!(Role::parse("member"), Some(Role::Member));
        assert_eq!(Role::parse("Owner"), None);
        assert_eq!(Role::parse(""), None);
        assert_eq!(Role::parse("admin"), None);
    }

    #[test]
    fn debug_output_never_carries_the_private_key_or_a_contributors_secrets() {
        let identity = Identity {
            v: 1,
            alg: "ed25519".into(),
            public: "pub-bytes".into(),
            private: "SECRET-SEED".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        };
        assert!(!format!("{identity:?}").contains("SECRET-SEED"));
        let contributor = Contributor {
            user_id: "u".into(),
            api_key: "SECRET-KEY".into(),
            password: Some("SECRET-PASSWORD".into()),
            avatar_done: false,
            via_peer: None,
            peer_user_id: None,
            home_peer: None,
        };
        let printed = format!("{contributor:?}");
        assert!(!printed.contains("SECRET-KEY"));
        assert!(!printed.contains("SECRET-PASSWORD"));
        // Empty IS "not provisioned", so there is nothing to redact — and nothing printed.
        let keyless = Contributor {
            api_key: String::new(),
            ..contributor
        };
        let keyless_printed = format!("{keyless:?}");
        assert!(keyless_printed.contains("api_key: \"\""));
        assert!(!keyless_printed.contains("SECRET-KEY"));
    }

    #[test]
    fn leaving_forgets_proxies_but_keeps_stored_copies() {
        let s = store();
        s.seen_add("m1", "stub-sum", "stub-asset", Some("origin-a"), false)
            .unwrap();
        s.seen_add("m1", "full-sum", "full-asset", Some("origin-b"), true)
            .unwrap();
        s.seen_forget_proxies("m1").unwrap();
        assert!(
            s.ledger_by_asset("stub-asset").unwrap().is_none(),
            "the proxy's row goes with the share"
        );
        let kept = s.ledger_by_asset("full-asset").unwrap();
        assert!(
            kept.as_ref().map(|r| r.stored_full).unwrap_or(false),
            "the stored copy keeps its row (and its origin) after a leave"
        );
        assert_eq!(kept.unwrap().origin_asset.as_deref(), Some("origin-b"));
        // An unlink deletes the accounts their assets belong to, so NOTHING may be left claiming
        // them.
        s.seen_forget_mapping("m1").unwrap();
        assert!(s.ledger_by_asset("full-asset").unwrap().is_none());
    }

    #[test]
    fn adopted_round_trips_as_null_never_zero() {
        let s = store();
        let m = |adopted: Option<bool>| Mapping {
            id: "m1".into(),
            role: Role::Member,
            album_id: "a1".into(),
            album_name: "A".into(),
            peer: "p1".into(),
            remote_album_id: None,
            remote_mapping_id: None,
            permissions: "contribute".into(),
            host_slug: None,
            via: "link".into(),
            for_peer_user_ids: None,
            album_owner_name: None,
            album_owner_id: None,
            adopted,
            reunified: None,
            dead: false,
            dead_at: None,
            dead_reason: None,
            fail_count: None,
            local_version: None,
            remote_version: None,
            comment_count: None,
            remote_comment_count: None,
        };
        s.state.lock().unwrap().mappings = vec![m(None)];
        s.save().unwrap();
        let conn = s.conn.lock().unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT adopted FROM mappings WHERE id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stored, None, "unset must be SQL NULL, never 0");
        drop(conn);

        s.state.lock().unwrap().mappings = vec![m(Some(true))];
        s.save().unwrap();
        let conn = s.conn.lock().unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT adopted FROM mappings WHERE id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stored, Some(1));
    }

    #[test]
    fn offered_allows_only_what_was_recorded_and_reconcile_revokes() {
        let s = store();
        assert!(!s.offered_allows(&["m1".into()], "a1").unwrap());
        s.offered_add("m1", &["a1".into(), "a2".into()]).unwrap();
        assert!(s.offered_allows(&["m1".into()], "a1").unwrap());
        // No mappings -> never allowed, not "allowed by default".
        assert!(!s.offered_allows(&[], "a1").unwrap());
        // Removal is real revocation.
        assert_eq!(
            s.offered_reconcile("m1", &["a2".into()]).unwrap(),
            vec!["a1".to_string()]
        );
        assert!(!s.offered_allows(&["m1".into()], "a1").unwrap());
    }

    #[test]
    fn published_albums_keep_directions_and_peers_apart() {
        let s = store();
        let album = |name: &str, owner: &str| OwnedAlbum {
            name: name.into(),
            asset_count: 3,
            start_date: Some("2026-01-01".into()),
            end_date: None,
            owner_name: "Nan".into(),
            owner_user_id: Some(owner.into()),
        };
        s.published_albums_set(
            "peer-1",
            Direction::ToThem,
            "u1",
            &[album("Zed", "u1"), album("Ann", "u1")],
        )
        .unwrap();
        s.published_albums_set("peer-1", Direction::FromThem, "u1", &[album("Other", "u1")])
            .unwrap();
        s.published_albums_set("peer-2", Direction::ToThem, "u1", &[album("Third", "u1")])
            .unwrap();

        let to_them = s.published_albums_for("peer-1", Direction::ToThem).unwrap();
        assert_eq!(to_them.len(), 2);
        assert_eq!(to_them[0].name, "Ann", "ordered by name");
        assert_eq!(to_them[1].name, "Zed");
        assert_eq!(
            s.published_albums_for("peer-1", Direction::FromThem)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            s.published_albums_for("peer-2", Direction::ToThem).unwrap()[0].name,
            "Third"
        );
    }

    #[test]
    fn replacing_a_peers_whole_index_clears_an_owner_who_went_silent() {
        let s = store();
        let album = |name: &str, owner: &str| OwnedAlbum {
            name: name.into(),
            asset_count: 1,
            start_date: None,
            end_date: None,
            owner_name: "Nan".into(),
            owner_user_id: Some(owner.into()),
        };
        s.published_albums_replace_peer(
            "p",
            Direction::ToThem,
            &[album("A", "u1"), album("B", "u2")],
        )
        .unwrap();
        assert_eq!(
            s.published_albums_for("p", Direction::ToThem)
                .unwrap()
                .len(),
            2
        );
        // Silence about u2 clears it; an empty index is an answer, not a no-op.
        s.published_albums_replace_peer("p", Direction::ToThem, &[album("A", "u1")])
            .unwrap();
        let left = s.published_albums_for("p", Direction::ToThem).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].name, "A");
        s.published_albums_replace_peer("p", Direction::ToThem, &[])
            .unwrap();
        assert!(s
            .published_albums_for("p", Direction::ToThem)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn cache_accounts_and_evicts_least_recently_used_first() {
        let s = store();
        assert_eq!(s.cache_total().unwrap(), 0);
        // `lastUsed` is Date.now() milliseconds in the TypeScript and here, and `ORDER BY lastUsed
        // ASC` has no secondary key — so two writes inside one millisecond order arbitrarily, in
        // both implementations. Real cache writes are separated by a network fetch, so the test
        // separates them too rather than asserting an ordering the query does not promise.
        s.cache_put("a", 100).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.cache_put("b", 200).unwrap();
        assert_eq!(s.cache_total().unwrap(), 300);
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert!(s.cache_touch("a").unwrap());
        assert!(!s.cache_touch("missing").unwrap());
        // `a` was just touched, so `b` is the oldest.
        let evicted = s.cache_evict_oldest().unwrap().unwrap();
        assert_eq!(evicted.0, "b");
        assert_eq!(s.cache_total().unwrap(), 100);
        assert!(s.cache_evict_oldest().unwrap().is_some());
        assert!(s.cache_evict_oldest().unwrap().is_none());
    }

    #[test]
    fn added_is_recorded_and_forgotten_so_a_hand_share_can_happen_again() {
        let s = store();
        assert!(!s.added_has("a1", "u1").unwrap());
        s.added_record("a1", "u1").unwrap();
        assert!(s.added_has("a1", "u1").unwrap());
        assert_eq!(s.added_albums_for("u1").unwrap(), vec!["a1".to_string()]);
        // Without the forget, this album could never again be shared by hand with that person.
        s.added_forget("a1", "u1").unwrap();
        assert!(!s.added_has("a1", "u1").unwrap());
    }

    /// The drop-in proof: read a state.db the TYPESCRIPT sidecar wrote. Ignored by default because
    /// it needs one — `ISA_COMPAT_DB=/path/to/state.db cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn reads_a_real_node_written_state_db() {
        let path =
            std::env::var("ISA_COMPAT_DB").expect("ISA_COMPAT_DB must name a state.db directory");
        let s = Store::open(&path).expect("open a Node-written store");
        assert_eq!(
            s.user_version().unwrap(),
            4,
            "the real database is at schema v4"
        );

        let state = s.state.lock().unwrap();
        let identity = state.identity.as_ref().expect("identity row");
        assert_eq!(identity.v, 1);
        assert_eq!(identity.alg, "ed25519");
        // The identity IS the transport: 32 raw bytes each side, base64url, no padding.
        let pub_bytes = b64url_decode(&identity.public).expect("pub is base64url");
        let priv_bytes = b64url_decode(&identity.private).expect("priv is base64url");
        assert_eq!(pub_bytes.len(), 32, "public key is the iroh endpoint id");
        assert_eq!(priv_bytes.len(), 32);
        assert!(!identity.public.contains('='), "unpadded");

        // The real proof, not merely that the strings parse: the stored 32-byte seed must DERIVE
        // the stored 32-byte public key. If it does, this key is usable as the transport identity —
        // it can sign, and iroh will accept it as the endpoint id — rather than just looking right.
        let seed: [u8; 32] = priv_bytes.as_slice().try_into().unwrap();
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let derived = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(signing.verifying_key().to_bytes());
        assert_eq!(
            derived, identity.public,
            "the seed derives the stored public key"
        );

        for p in &state.peers {
            // NULL is a legitimate value here and the real database has one: the TypeScript writes
            // a peer with no recorded protocol (learned before a version exchange), and NEITHER
            // implementation gates on the stored value — the only protocol check is a fail-open
            // warning in join.ts against the HELLO, not against this column. Asserting Some(2) here
            // was asserting what a RUST-written database happens to contain.
            assert!(
                p.protocol.is_none() || p.protocol == Some(2),
                "a peer's protocol is unrecorded or 2, never something else: {:?}",
                p.protocol
            );
            assert_eq!(
                p.pub_key,
                p.pub_key.trim(),
                "pub key is a clean base64url string"
            );
            assert!(!p.name.is_empty());
        }
        for m in &state.mappings {
            assert!(!m.id.is_empty());
            assert!(m.role == Role::Owner || m.role == Role::Member);
        }
        eprintln!(
            "read a real state.db: {} peers, {} mappings, {} contributors, identity {}…",
            state.peers.len(),
            state.mappings.len(),
            state.contributors.len(),
            &identity.public[..8]
        );
    }

    fn b64url_decode(s: &str) -> Option<Vec<u8>> {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = Vec::new();
        let mut acc: u32 = 0;
        let mut bits = 0;
        for c in s.bytes() {
            let v = T.iter().position(|&t| t == c)? as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod contributor_persistence_tests {
    use super::*;

    fn contributor(name: &str) -> Contributor {
        Contributor {
            user_id: format!("uid-{name}"),
            api_key: format!("key-{name}"),
            password: None,
            avatar_done: true,
            via_peer: Some("peer-a".into()),
            peer_user_id: Some("u1".into()),
            home_peer: None,
        }
    }

    #[test]
    fn contributors_survive_a_save_and_reload() {
        let dir = std::env::temp_dir().join(format!("isa-contrib-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap().to_string();

        {
            let s = Store::open(&path).unwrap();
            s.state
                .lock()
                .unwrap()
                .contributors
                .insert("person-a".into(), contributor("a"));
            s.save().unwrap();
            // A SECOND save with another contributor added — the shape the materialiser creates:
            // a host stand-in first, then one per remote person.
            s.state
                .lock()
                .unwrap()
                .contributors
                .insert("person-b".into(), contributor("b"));
            s.save().unwrap();
        }

        let reloaded = Store::open(&path).unwrap();
        let collections = reloaded.state.lock().unwrap();
        assert_eq!(
            collections.contributors.len(),
            2,
            "both contributors must persist"
        );
        assert!(collections.contributors.contains_key("person-a"));
        assert!(collections.contributors.contains_key("person-b"));
        assert_eq!(
            collections.contributors["person-b"].api_key.as_str(),
            "key-b"
        );
        drop(collections);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_keys_persist_together_and_reload_as_empty() {
        // Empty IS the stored "not provisioned yet" state — a mid-provisioning crash persists
        // `userId=""`/`apiKey=""` — so a save must accept it and a reload must hand back EMPTY,
        // not a value a gate could mistake for provisioned. The `userId` UNIQUE index still allows
        // only ONE such row, so the crash shape is pinned beside two keyless accounts with real
        // ids, and all three survive one save together.
        let dir = std::env::temp_dir().join(format!("isa-contrib-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap().to_string();

        let keyless = |id: &str| Contributor {
            user_id: id.into(),
            api_key: String::new(),
            password: None,
            avatar_done: false,
            via_peer: Some("peer-a".into()),
            peer_user_id: Some("origin-1".into()),
            home_peer: None,
        };
        {
            let s = Store::open(&path).unwrap();
            s.state
                .lock()
                .unwrap()
                .contributors
                .insert("person-a".into(), keyless("uid-a"));
            s.state
                .lock()
                .unwrap()
                .contributors
                .insert("person-b".into(), keyless("uid-b"));
            // The crash shape: the id never landed either.
            s.state
                .lock()
                .unwrap()
                .contributors
                .insert("person-mid".into(), keyless(""));
            s.save().unwrap();
        }

        let reloaded = Store::open(&path).unwrap();
        let collections = reloaded.state.lock().unwrap();
        assert_eq!(
            collections.contributors.len(),
            3,
            "all three must persist through one save"
        );
        for slug in ["person-a", "person-b", "person-mid"] {
            assert_eq!(
                collections.contributors[slug].api_key, "",
                "{slug} reloads keyless"
            );
        }
        assert_eq!(collections.contributors["person-mid"].user_id, "");
        drop(collections);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_rows_sharing_one_id_are_still_refused_by_the_schema() {
        // Not the type's decision: `userId TEXT NOT NULL UNIQUE` refuses a second row with the SAME
        // id, empty or not, so two records naming one account cannot both persist and the save
        // fails as a whole — exactly as it did when the fields were Options.
        let dir = std::env::temp_dir().join(format!("isa-contrib-uniq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap().to_string();

        let s = Store::open(&path).unwrap();
        // Both carry the same `uid-a`: the schema, not the save, is what refuses this.
        s.state
            .lock()
            .unwrap()
            .contributors
            .insert("person-a".into(), contributor("a"));
        s.state
            .lock()
            .unwrap()
            .contributors
            .insert("person-b".into(), contributor("a"));
        assert!(
            s.save().is_err(),
            "a duplicated id must fail the save, not silently collapse"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
