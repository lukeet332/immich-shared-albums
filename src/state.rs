/** state.rs — the store instance, this household's transport identity, and the thin accessors. See ARCHITECTURE.md. */
use crate::config::cfg;
use crate::store::{Collections, Identity, Store, StoreError};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::SigningKey;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock, RwLock};

/// The process-wide state: the store, the identity, and the peers whose unlink is in progress.
pub struct State {
    pub store: Store,
    /// An unlink deletes the peer's utility accounts before it removes the peer record, and a
    /// materialisation already in flight for that peer would otherwise re-provision one of them in
    /// the gap — an orphan bot account for a server you just unlinked. Provisioning consults this
    /// set AND the peer list, so the window is closed from both ends.
    unlinking: RwLock<HashSet<String>>,
}

static STATE: OnceLock<Arc<State>> = OnceLock::new();

// Set while THIS thread holds a `collections()` guard. The flag is per thread because the lock is
// held by one thread at a time: another thread waiting for it is contention, not re-entrancy.
thread_local! {
    static HOLDING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A `collections()` guard. Clears the re-entrancy flag when it drops.
pub struct CollectionsGuard<'a> {
    inner: std::sync::MutexGuard<'a, Collections>,
}

impl std::ops::Deref for CollectionsGuard<'_> {
    type Target = Collections;
    fn deref(&self) -> &Collections {
        &self.inner
    }
}

impl std::ops::DerefMut for CollectionsGuard<'_> {
    fn deref_mut(&mut self) -> &mut Collections {
        &mut self.inner
    }
}

impl Drop for CollectionsGuard<'_> {
    fn drop(&mut self) {
        HOLDING.with(|holding| holding.set(false));
    }
}

impl State {
    /// Boot order: make the data directory private, warn when it is not a mounted volume, open the
    /// store, and make sure this household has an identity. Mirrors `state.ts`'s module-load body.
    pub fn boot() -> Result<Arc<State>, StateError> {
        let data_dir = cfg().data_dir.clone();
        std::fs::create_dir_all(&data_dir).map_err(|e| StateError::Io(e.to_string()))?;
        restrict_data_dir(&data_dir)?;
        warn_if_not_a_volume(&data_dir);

        let store = Store::open(&data_dir)?;
        let state = Arc::new(State { store, unlinking: RwLock::new(HashSet::new()) });
        state.ensure_identity()?;
        // Persist immediately, so a first boot leaves a usable store even if nothing else runs.
        state.save()?;
        Ok(state)
    }

    /// This household's transport identity — the sidecar's whole identity on the wire. Minted on
    /// first boot and persisted; every consumer downstream can rely on it.
    pub fn ensure_identity(&self) -> Result<Identity, StateError> {
        if let Some(existing) = self.identity() {
            return Ok(existing);
        }
        let signing = SigningKey::generate(&mut rand_core::OsRng);
        let identity = Identity {
            v: 1,
            alg: "ed25519".to_string(),
            // Raw 32 bytes each side, unpadded base64url — the same encoding Node's JWK export
            // produces, and byte-for-byte what iroh speaks as the endpoint id.
            public: URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
            private: URL_SAFE_NO_PAD.encode(signing.to_bytes()),
            created_at: crate::config::iso_now(),
        };
        self.store.state.lock().unwrap().identity = Some(identity.clone());
        Ok(identity)
    }

    /// A State over a caller-supplied store, for tests that do not want a temp directory.
    #[cfg(test)]
    pub fn for_test(store: Store) -> Self {
        State { store, unlinking: RwLock::new(HashSet::new()) }
    }

    pub fn identity(&self) -> Option<Identity> {
        self.store.state.lock().unwrap().identity.clone()
    }

    /// The identity as a non-null value. Panics only if called before `boot`, which is a wiring bug.
    pub fn keys(&self) -> Identity {
        self.identity().expect("State::boot must run before keys()")
    }

    pub fn save(&self) -> Result<(), StoreError> {
        self.store.save()
    }

    pub fn collections(&self) -> CollectionsGuard<'_> {
        // RE-ENTRANCY IS A DEADLOCK, and a silent one: `std::sync::Mutex` is not reentrant, so a
        // second borrow on the same thread blocks forever while holding the lock every other task
        // needs. That exact shape has hung this sidecar three times, at a cost of six debugging
        // rounds, and neither the type system nor clippy can see it. A thread-local flag turns it
        // into an immediate, named panic instead — including the `if let` scrutinee case, where the
        // guard lives for the whole body.
        HOLDING.with(|holding| {
            if holding.get() {
                panic!(
                    "collections() taken twice on one thread: bind the guard in its own statement, \
                     and never inside an argument, an `if let` scrutinee or a closure"
                );
            }
            holding.set(true);
        });
        CollectionsGuard { inner: self.store.state.lock().unwrap() }
    }

    /// Close the re-provision window for a peer an unlink is working on.
    /// Close the re-provision window again once a teardown has finished, so the peer can be
    /// re-linked without the sidecar refusing work for a link that no longer exists.
    pub fn clear_unlinking(&self, pub_key: &str) {
        self.unlinking.write().unwrap().remove(pub_key);
    }

    pub fn mark_unlinking(&self, pub_key: &str) {
        self.unlinking.write().unwrap().insert(pub_key.to_string());
    }

    pub fn unmark_unlinking(&self, pub_key: &str) {
        self.unlinking.write().unwrap().remove(pub_key);
    }

    pub fn peer_is_linked(&self, pub_key: Option<&str>) -> bool {
        let Some(pub_key) = pub_key else { return false };
        if self.unlinking.read().unwrap().contains(pub_key) {
            return false;
        }
        self.collections().peers.iter().any(|p| p.pub_key == pub_key)
    }

    /// Admin setting (default OFF): store mirrored photos as full local copies instead of hotlink
    /// stubs, so an album survives the owner going offline.
    pub fn store_shared_assets_locally(&self) -> bool {
        self.store
            .kv("settings")
            .ok()
            .flatten()
            .and_then(|v| v.get("storeSharedAssetsLocally").and_then(|b| b.as_bool()))
            .unwrap_or(false)
    }

    /// The checksum that travels on the wire. A materialised proxy keeps its SOURCE photo's
    /// checksum in the ledger — that identity, not the local file's checksum (a re-encoded
    /// preview), is what a peer must see.
    pub fn wire_checksum(&self, asset_id: &str, fallback: &str) -> String {
        self.store
            .ledger_by_asset(asset_id)
            .ok()
            .flatten()
            .map(|entry| entry.checksum)
            .unwrap_or_else(|| fallback.to_string())
    }
}

/// 0700: this directory holds the identity key and every bot account's API key.
fn restrict_data_dir(data_dir: &str) -> Result<(), StateError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(data_dir, perms).map_err(|e| StateError::Io(e.to_string()))?;
    }
    Ok(())
}

/// The identity key IS this server's identity: lose the volume and every pairing dies with it. A
/// data dir on the container's own filesystem (or an anonymous volume) survives restarts but not
/// recreation, so say so loudly rather than letting the next `down` lose it silently.
fn warn_if_not_a_volume(data_dir: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // stat quirks on exotic filesystems must not stop boot.
        let (Ok(dir), Ok(root)) = (std::fs::metadata(data_dir), std::fs::metadata("/")) else {
            return;
        };
        if dir.dev() == root.dev() {
            eprintln!(
                "WARNING: {data_dir} is not a mounted volume — this server's identity will be lost \
                 when the container is recreated. Bind-mount it (see deploy/docker-compose.example.yml)."
            );
        }
    }
}

pub fn install(state: Arc<State>) {
    let _ = STATE.set(state);
}

/// The process-wide state. Panics if read before `install` — a wiring bug, not a runtime condition.
pub fn state() -> &'static Arc<State> {
    STATE.get().expect("state::install must run before state()")
}

#[derive(Debug)]
pub enum StateError {
    Io(String),
    Store(StoreError),
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::Io(e) => write!(f, "io: {e}"),
            StateError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StateError {}

impl From<StoreError> for StateError {
    fn from(e: StoreError) -> Self {
        StateError::Store(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() {
        crate::config::install_test_config();
    }

    fn boot(dir: &str) -> Arc<State> {
        test_config();
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let store = Store::open(dir).unwrap();
        let state = Arc::new(State { store, unlinking: RwLock::new(HashSet::new()) });
        state.ensure_identity().unwrap();
        state.save().unwrap();
        state
    }

    #[test]
    fn mints_an_identity_of_the_shape_the_wire_expects() {
        let s = boot("/tmp/isa-state-identity");
        let keys = s.keys();
        assert_eq!(keys.v, 1);
        assert_eq!(keys.alg, "ed25519");
        // Both sides are RAW 32-byte keys, unpadded base64url — never a DER envelope.
        assert_eq!(URL_SAFE_NO_PAD.decode(&keys.public).unwrap().len(), 32);
        assert_eq!(URL_SAFE_NO_PAD.decode(&keys.private).unwrap().len(), 32);
        assert!(!keys.public.contains('='), "unpadded, like Node's JWK export");
        assert!(keys.created_at.ends_with('Z'), "ISO-8601 UTC with millis");
    }

    #[test]
    fn the_identity_survives_a_restart_and_is_never_re_minted() {
        let first = boot("/tmp/isa-state-restart");
        let original = first.keys().public;
        // Re-open the same directory, as a container restart does.
        let store = Store::open("/tmp/isa-state-restart").unwrap();
        let second = Arc::new(State { store, unlinking: RwLock::new(HashSet::new()) });
        let reloaded = second.ensure_identity().unwrap();
        assert_eq!(reloaded.public, original, "the identity key IS this server");
    }

    #[test]
    fn a_peer_is_linked_only_while_it_is_a_peer_and_not_unlinking() {
        let s = boot("/tmp/isa-state-peers");
        assert!(!s.peer_is_linked(None));
        assert!(!s.peer_is_linked(Some("unknown")));

        s.collections().peers.push(crate::store::Peer {
            pub_key: "peer-1".into(),
            name: "B".into(),
            version: Some("1.1.1".into()),
            protocol: Some(2),
            features: Some(vec!["sync-status".into()]),
            via: "pair".into(),
            first_seen_at: "2026-01-01T00:00:00.000Z".into(),
            relay_hint: None,
            last_addrs: None,
        });
        assert!(s.peer_is_linked(Some("peer-1")));

        // An unlink in progress must read as unlinked, or a materialisation in flight re-provisions
        // a bot account for a server that is being removed.
        s.mark_unlinking("peer-1");
        assert!(!s.peer_is_linked(Some("peer-1")));
        s.unmark_unlinking("peer-1");
        assert!(s.peer_is_linked(Some("peer-1")));
    }

    #[test]
    fn wire_checksum_prefers_the_ledger_over_the_local_file() {
        let s = boot("/tmp/isa-state-wire");
        // No ledger row: the local checksum stands.
        assert_eq!(s.wire_checksum("asset-1", "local-sum"), "local-sum");
        // A materialised proxy records its SOURCE photo's checksum; that is what travels.
        s.store.seen_add("m1", "source-sum", "asset-1", Some("origin-1"), false).unwrap();
        assert_eq!(s.wire_checksum("asset-1", "local-sum"), "source-sum");
    }

    #[test]
    fn store_shared_assets_locally_defaults_off() {
        let s = boot("/tmp/isa-state-settings");
        assert!(!s.store_shared_assets_locally(), "the admin setting defaults OFF");
        s.store.kv_set("settings", &serde_json::json!({"storeSharedAssetsLocally": true})).unwrap();
        assert!(s.store_shared_assets_locally());
    }

    /// Exercises the REAL boot path, because 0700 is applied by `boot`, not by the store.
    #[test]
    fn boot_makes_the_data_directory_private_and_mints_an_identity() {
        let dir = "/tmp/isa-test-data";
        test_config();
        let _ = std::fs::remove_dir_all(dir);
        let booted = State::boot().expect("boot");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "the identity key and every bot API key live here");
        }
        let keys = booted.keys();
        assert_eq!(URL_SAFE_NO_PAD.decode(&keys.public).unwrap().len(), 32);
        // Booting persists immediately, so a first boot leaves a usable store.
        assert!(booted.store.kv("identity").unwrap().is_some());
    }
}
