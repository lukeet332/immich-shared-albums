/** media/cache.rs — a bounded LRU byte-cache for streamed previews. See ARCHITECTURE.md. */
use crate::config::cfg;
use crate::state::state;
use sha1::{Digest, Sha1};

/// Previews live beside the identity, under the data dir. A cache, not storage: capped,
/// reclaimable, and safe to delete. The accounting is in SQLite (`cache`), the bytes on disk.
pub fn cache_dir() -> String {
    format!("{}/cache", cfg().data_dir)
}

/// Files are named by the hash of the ORIGIN asset id — the local stub id differs per household,
/// so keying on it would miss every viewer but the one that materialised the row.
pub fn cache_key(origin_asset: &str) -> String {
    Sha1::digest(origin_asset.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A hit refreshes the LRU slot, so a photo the household keeps looking at is never evicted by
/// one they looked at once.
pub async fn cache_read(origin_asset: &str) -> Option<Vec<u8>> {
    if cfg().cache_max_mb == 0 {
        return None;
    }
    let key = cache_key(origin_asset);
    if !state().store.cache_touch(&key).unwrap_or(false) {
        return None;
    }
    // The index said yes and the disk may still say no — an operator cleaning the cache directory
    // by hand is not an error. A miss here is a miss, and the next write heals it.
    tokio::fs::read(format!("{}/{key}", cache_dir())).await.ok()
}

/// Best-effort: a cache that cannot be written is a slower page, never a failed request, so every
/// failure here is swallowed deliberately.
pub async fn cache_write(origin_asset: &str, bytes: &[u8]) {
    let cap = cfg().cache_max_mb;
    if cap == 0 {
        return;
    }
    let cap_bytes = cap * 1024 * 1024;
    // No single item past 10% of the cap: previews are ~100KB, so anything near this is not one,
    // and letting it in would evict the whole cache to hold one file.
    if bytes.len() as u64 > cap_bytes / 10 {
        return;
    }
    let key = cache_key(origin_asset);
    let dir = cache_dir();
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return;
    }
    if tokio::fs::write(format!("{dir}/{key}"), bytes).await.is_err() {
        return;
    }
    let store = &state().store;
    let _ = store.cache_put(&key, bytes.len() as i64);
    // Evict until under the cap. A row that cannot be read stops the loop rather than spinning:
    // the alternative is an unbounded loop on a store error.
    while store.cache_total().unwrap_or(0) > cap_bytes as i64 {
        let Ok(Some((evicted, _))) = store.cache_evict_oldest() else {
            break;
        };
        let _ = tokio::fs::remove_file(format!("{dir}/{evicted}")).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_is_the_hash_of_the_origin_asset_not_the_local_one() {
        // Two households mirroring the same photo have different local stub ids and must share a
        // cache entry, so the key can only come from the origin's id.
        assert_eq!(cache_key("origin-a"), cache_key("origin-a"));
        assert_ne!(cache_key("origin-a"), cache_key("origin-b"));
        assert_eq!(cache_key("origin-a").len(), 40, "sha1 hex");
    }
}
