/** sync/reclaim.rs — the ledger's last resort: stubs whose mapping is gone are reclaimed, not kept for ever. See ARCHITECTURE.md. */
use crate::immich::materialise::{delete_proxy_asset, PurgeOutcome};
use crate::state::State;
use crate::store::SeenEntry;
use std::collections::HashSet;

/// Reclaim at most this many stubs per pass. A leave that could not purge leaves its rows behind
/// as the only handle on the orphaned bytes (see `leave.rs`), so the backlog is normally a handful;
/// the bound keeps a pathological store from turning one directory cycle into a deletion spree.
const ORPHAN_BATCH: usize = 50;

/// What may be done about one orphan row — a ledger row whose mapping no longer exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanRow {
    /// The asset is still served by a LIVE mapping's authoritative row (a deduped proxy carries
    /// rows from several mappings). The bytes stay; only this stale pointer goes.
    ServesAnother,
    /// Ask Immich to delete the stub. `Purged`/`AlreadyGone` settle the row; anything else keeps
    /// it, because the row is the only record the stub exists.
    Reclaim,
}

/// The decision for one row, as a pure function so the accounting is testable. `row_mapping_live`
/// says the row's own mapping still exists (dead ones included — their teardown paths own them);
/// `authoritative_owner_live` is `ledger_by_asset`'s answer for the row's local asset, mapped to
/// whether THAT mapping is live. `None` rows are not this module's business.
fn decide(row_mapping_live: bool, authoritative_owner_live: Option<bool>) -> Option<OrphanRow> {
    if row_mapping_live {
        // Not an orphan: its own teardown path owns it, and this module must never race it.
        return None;
    }
    match authoritative_owner_live {
        Some(true) => Some(OrphanRow::ServesAnother),
        _ => Some(OrphanRow::Reclaim),
    }
}

/// Reclaim stubs whose ledger row names a mapping that no longer exists. Called from the directory
/// lane, throttled (`reclaim_when_due`): a leave that could not purge leaves its rows behind on
/// purpose (the row is the only handle on the orphaned bytes), and this is what eventually collects
/// them — "withdrawal reclaims the space" is a promise, so a failed purge cannot mean for ever.
pub async fn reclaim_orphaned_stubs(state: &State, client: &crate::immich::client::Client) {
    let Some(work) = candidates(state) else {
        return;
    };
    let mut settled = 0usize;
    let mut still_stuck = 0usize;
    for (entry, action) in work.iter().take(ORPHAN_BATCH) {
        match action {
            OrphanRow::ServesAnother => {
                // The stub is a live share's photo. Drop only the stale pointer.
                let _ = state
                    .store
                    .seen_remove_entry(&entry.mapping, &entry.checksum);
                settled += 1;
            }
            OrphanRow::Reclaim => {
                match delete_proxy_asset(state, client, &entry.local_asset).await {
                    Ok(PurgeOutcome::Purged) | Ok(PurgeOutcome::AlreadyGone) => {
                        let _ = state
                            .store
                            .seen_remove_entry(&entry.mapping, &entry.checksum);
                        settled += 1;
                    }
                    Ok(PurgeOutcome::NotOurs) | Err(_) => still_stuck += 1,
                }
            }
        }
    }
    if settled > 0 || still_stuck > 0 {
        crate::log!(
            "orphan reclaim: {settled} ledger row(s) settled, {still_stuck} stub(s) still un-reclaimable — kept for the next pass"
        );
    }
}

/// The rows this module acts on, with their decision resolved BEFORE any await: the mapping's
/// liveness and the asset's authoritative owner are both read from the store and the in-memory
/// collections, and neither must be re-asked across the deletion awaits below.
fn candidates(state: &State) -> Option<Vec<(SeenEntry, OrphanRow)>> {
    let rows = state.store.seen_origin_rows().ok()?;
    // The guard binds in its own statement (see `collections()`): never inside the expression that
    // uses it.
    let collections = state.collections();
    let live: HashSet<&str> = collections.mappings.iter().map(|m| m.id.as_str()).collect();
    let mut out = Vec::new();
    for entry in rows {
        if entry.stored_full {
            // A stored copy is the household's own paid-for bytes; its mapping's absence does not
            // make them orphans. The leave that kept the row said so.
            continue;
        }
        let row_mapping_live = live.contains(entry.mapping.as_str());
        let authoritative_owner_live = state
            .store
            .ledger_by_asset(&entry.local_asset)
            .ok()
            .flatten()
            .map(|owner| live.contains(owner.mapping.as_str()));
        if let Some(action) = decide(row_mapping_live, authoritative_owner_live) {
            out.push((entry, action));
        }
    }
    Some(out)
}

/// Throttle: run at most once per interval, from the directory lane (the cheapest one), after its
/// own work. First call runs immediately, so a failed purge left behind by a leave that then
/// spliced the mapping is noticed on the next cycle rather than only after the first interval.
pub async fn reclaim_when_due(state: &State, client: &crate::immich::client::Client) {
    static LAST_RUN: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let now = std::time::Instant::now();
    let due = {
        let mut last = LAST_RUN.lock().unwrap();
        match *last {
            Some(last) if now.duration_since(last) < ORPHAN_RECLAIM_INTERVAL => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    };
    if due {
        reclaim_orphaned_stubs(state, client).await;
    }
}

/// How often the directory lane offers the ledger a chance to collect its orphans.
const ORPHAN_RECLAIM_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_of_a_live_mapping_is_never_this_modules_business() {
        // The mapping's own teardown paths own its rows; a reclaim racing a leave would delete
        // bytes a share still serves.
        assert_eq!(decide(true, None), None);
        assert_eq!(decide(true, Some(true)), None);
        assert_eq!(decide(true, Some(false)), None);
    }

    #[test]
    fn an_orphan_served_by_a_live_share_loses_only_its_stale_pointer() {
        // A deduped proxy carries rows from several mappings: the other mapping's share still
        // serves the bytes, so deleting the asset would break a live album.
        assert_eq!(decide(false, Some(true)), Some(OrphanRow::ServesAnother));
    }

    #[test]
    fn an_orphan_nobody_live_claims_is_reclaimed_whatever_the_ledger_says() {
        // The authoritative row names a DEAD mapping, or the asset resolves to nothing: the bytes
        // are claimed by nobody alive, which is exactly the space withdrawal owes back.
        assert_eq!(decide(false, Some(false)), Some(OrphanRow::Reclaim));
        assert_eq!(decide(false, None), Some(OrphanRow::Reclaim));
    }

    #[test]
    // Const-folded, but the relationship is the contract: one pass deletes a bounded handful.
    #[allow(clippy::assertions_on_constants)]
    fn the_batch_is_bounded_so_one_store_cannot_become_a_deletion_spree() {
        assert!(ORPHAN_BATCH > 0);
        assert!(ORPHAN_BATCH < 1000);
    }
}
