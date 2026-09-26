/** sync/reclaim.rs — the ledger's last resort: stubs whose mapping is gone are reclaimed, not kept for ever. See ARCHITECTURE.md. */
use crate::immich::materialise::{delete_proxy_asset, PurgeOutcome};
use crate::state::State;
use crate::store::SeenEntry;

/// How many orphans one pass may delete, and how many rows one pass may READ: both are bounded, so
/// neither a pathological ledger nor a stuck row can turn a directory cycle into a deletion spree —
/// and the pass's cost does not grow with the ledger (`orphan_scan` is keyset-paginated).
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
/// whether THAT mapping is live — computed ONLY from a successful read, never from a failed one.
/// `None` rows are not this module's business.
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
    let mut settled = 0usize;
    let mut still_stuck = 0usize;
    let mut skipped = 0usize;
    let mut attempted = 0usize;
    for (id, entry, action) in candidates(state) {
        // The cursor advances past every row the pass READ, whichever way it was decided: a row
        // this pass could not settle must not pin the window, or later orphans would never be
        // attempted while the stuck ones were retried for ever.
        advance_cursor(id);
        attempted += 1;
        match action {
            None => skipped += 1,
            Some(OrphanRow::ServesAnother) => {
                // The stub is a live share's photo. Drop only the stale pointer.
                let _ = state
                    .store
                    .seen_remove_entry(&entry.mapping, &entry.checksum);
                settled += 1;
            }
            Some(OrphanRow::Reclaim) => {
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
    if settled > 0 || still_stuck > 0 || skipped > 0 {
        crate::log!(
            "orphan reclaim: {settled} ledger row(s) settled, {still_stuck} stub(s) still un-reclaimable, {skipped} row(s) deferred with an unreadable ledger — {attempted} looked at, kept for the next pass"
        );
    }
}

/// Where the last pass stopped in the ledger. A pass that reads a FULL window continues from here;
/// a short one means the ledger was walked to its end and the next pass wraps to the beginning, so
/// a row is never skipped for ever — kept rows (the un-reclaimable ones) simply come round again.
fn last_cursor() -> i64 {
    CURSOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .to_owned()
}

fn advance_cursor(id: i64) {
    *CURSOR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = id;
}

static CURSOR: std::sync::Mutex<i64> = std::sync::Mutex::new(0);

/// The rows this module acts on, with their decision resolved BEFORE any await: the mapping's
/// liveness and the asset's authoritative owner are both read from the store and the in-memory
/// collections, and neither must be re-asked across the deletion awaits below.
///
/// A FAILED ledger read defers the row rather than deciding from it: `.ok()` would read "could not
/// ask" as "claimed by nobody", and a live mapping's photo would be deleted on a database hiccup.
fn candidates(state: &State) -> Vec<(i64, SeenEntry, Option<OrphanRow>)> {
    // The guard binds in its own statement (see `collections()`): never inside the expression that
    // uses it.
    let Ok(rows) = state.store.orphan_scan(last_cursor(), ORPHAN_BATCH) else {
        return Vec::new();
    };
    let collections = state.collections();
    let live: std::collections::HashSet<&str> =
        collections.mappings.iter().map(|m| m.id.as_str()).collect();
    let mut out = Vec::new();
    for (id, entry) in rows {
        let row_mapping_live = live.contains(entry.mapping.as_str());
        let authoritative_owner_live = match state.store.ledger_by_asset(&entry.local_asset) {
            Ok(owner) => owner.map(|owner| live.contains(owner.mapping.as_str())),
            Err(_) => {
                out.push((id, entry, None));
                continue;
            }
        };
        let action = decide(row_mapping_live, authoritative_owner_live);
        out.push((id, entry, action));
    }
    out
}

/// Throttle: run at most once per interval, from the directory lane (the cheapest one), after its
/// own work. First call runs immediately, so a failed purge left behind by a leave that then
/// spliced the mapping is noticed on the next cycle rather than only after the first interval.
pub async fn reclaim_when_due(state: &State, client: &crate::immich::client::Client) {
    static LAST_RUN: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let now = std::time::Instant::now();
    let due = {
        // A poisoned lock here means a task panicked while deciding to run; the value it held is
        // still the truth about the last run, so recover and go on (the standard remedy).
        let mut last = LAST_RUN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
