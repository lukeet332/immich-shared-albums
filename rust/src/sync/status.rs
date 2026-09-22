/** sync/status.rs — whether a mapping has finished its work, answered rather than guessed. See PORT.md. */
use crate::store::Mapping;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// Whether a mapping has converged, in the shape the wire carries.
///
/// Every wait in this system used to be a timeout because the sidecar had no way to say "I'm done".
/// The cursors are written only after a CLEAN pass, which is exactly what a caller needs and
/// exactly what was never exposed before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncStatus {
    pub settled: bool,
    /// Always 0 today; the field exists because the wire shape is frozen.
    pub pending: i64,
    pub cycles: i64,
    #[serde(rename = "failCount")]
    pub fail_count: i64,
    pub dead: bool,
}

/// Watcher cycles completed per mapping since boot. In memory ON PURPOSE: a progress indicator for
/// callers waiting on convergence, not a fact worth a schema migration.
pub fn record_watcher_cycle(mapping_id: &str) {
    let mut map = cycles().lock().unwrap();
    *map.entry(mapping_id.to_string()).or_insert(0) += 1;
}

pub fn forget_watcher_cycles(mapping_id: &str) {
    cycles().lock().unwrap().remove(mapping_id);
}

pub fn watcher_cycles(mapping_id: &str) -> i64 {
    cycles().lock().unwrap().get(mapping_id).copied().unwrap_or(0)
}

fn cycles() -> &'static std::sync::Mutex<std::collections::HashMap<String, i64>> {
    static CYCLES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, i64>>> =
        std::sync::OnceLock::new();
    CYCLES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Which loop a tick belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LoopName {
    Watcher,
    Invites,
    Comments,
}

static WATCHER_TICKS: AtomicU64 = AtomicU64::new(0);
static INVITE_TICKS: AtomicU64 = AtomicU64::new(0);
static COMMENT_TICKS: AtomicU64 = AtomicU64::new(0);

/// Loop evaluations since boot, counted at the TOP of each tick — before the untouched-album skip,
/// before any early return. A caller asking "has the sidecar looked N more times and left things
/// alone?" needs this, because the cycle counter above stops advancing the moment a mapping settles.
pub fn record_loop_tick(loop_name: LoopName) {
    match loop_name {
        LoopName::Watcher => WATCHER_TICKS.fetch_add(1, Ordering::Relaxed),
        LoopName::Invites => INVITE_TICKS.fetch_add(1, Ordering::Relaxed),
        LoopName::Comments => COMMENT_TICKS.fetch_add(1, Ordering::Relaxed),
    };
}

pub fn loop_ticks() -> (u64, u64, u64) {
    (
        WATCHER_TICKS.load(Ordering::Relaxed),
        INVITE_TICKS.load(Ordering::Relaxed),
        COMMENT_TICKS.load(Ordering::Relaxed),
    )
}

/// Nudges RECEIVED since boot, by kind. A nudge and a sweep produce the same end state, so a test
/// that only looks at state cannot tell which did the work — this makes "the nudge did it" an
/// assertion rather than a hope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NudgeKind {
    Album,
    Index,
    Invitations,
}

static ALBUM_NUDGES: AtomicU64 = AtomicU64::new(0);
static INDEX_NUDGES: AtomicU64 = AtomicU64::new(0);
static INVITATION_NUDGES: AtomicU64 = AtomicU64::new(0);

pub fn record_nudge(kind: NudgeKind) {
    match kind {
        NudgeKind::Album => ALBUM_NUDGES.fetch_add(1, Ordering::Relaxed),
        NudgeKind::Index => INDEX_NUDGES.fetch_add(1, Ordering::Relaxed),
        NudgeKind::Invitations => INVITATION_NUDGES.fetch_add(1, Ordering::Relaxed),
    };
}

pub fn nudges_received() -> (u64, u64, u64) {
    (
        ALBUM_NUDGES.load(Ordering::Relaxed),
        INDEX_NUDGES.load(Ordering::Relaxed),
        INVITATION_NUDGES.load(Ordering::Relaxed),
    )
}

/// `album_updated_at` is the local album's version as read this cycle; a settled `localVersion`
/// must equal it. `None` answers from state alone (a status probe off the sync path), where an
/// absent cursor counts as NOT settled rather than optimistically settled.
pub fn sync_status(
    mapping: &Mapping,
    album_updated_at: Option<&str>,
    cycles: i64,
) -> SyncStatus {
    let fail_count = mapping.fail_count.unwrap_or(0);
    // Deferred refs are invisible in the ledger BY DESIGN — they are the ones NOT recorded. What is
    // visible is that `local_version` never advanced to the album's current version, because that
    // write only happens when a pass had nothing left to defer.
    let pushed = album_updated_at
        .map(|version| mapping.local_version.as_deref() == Some(version))
        .unwrap_or(false);
    let settled = !mapping.dead
        && fail_count == 0
        && if album_updated_at.is_some() { pushed } else { mapping.local_version.is_some() };
    SyncStatus { settled, pending: 0, cycles, fail_count, dead: mapping.dead }
}

/// A human-readable one-liner for logs: why a mapping is not settled.
pub fn why_not_settled(status: &SyncStatus) -> &'static str {
    if status.dead {
        "retired"
    } else if status.fail_count > 0 {
        "failed cycles"
    } else {
        "refs deferred"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Role;

    fn mapping(dead: bool, fail_count: Option<i64>, local_version: Option<&str>) -> Mapping {
        Mapping {
            id: "m1".into(),
            role: Role::Member,
            album_id: "a1".into(),
            album_name: "Holidays".into(),
            peer: "peer-a".into(),
            remote_album_id: None,
            remote_mapping_id: None,
            permissions: "contribute".into(),
            host_slug: None,
            via: "link".into(),
            for_peer_user_ids: None,
            album_owner_name: None,
            album_owner_id: None,
            adopted: None,
            reunified: None,
            dead,
            dead_at: None,
            dead_reason: None,
            fail_count,
            local_version: local_version.map(str::to_string),
            remote_version: None,
            comment_count: None,
            remote_comment_count: None,
        }
    }

    #[test]
    fn a_mapping_is_settled_when_the_cursor_caught_the_albums_version() {
        let m = mapping(false, None, Some("2026-01-01T00:00:00.000Z"));
        let s = sync_status(&m, Some("2026-01-01T00:00:00.000Z"), 3);
        assert!(s.settled);
        assert_eq!(s.cycles, 3);
        assert_eq!(s.pending, 0);
    }

    #[test]
    fn a_cursor_behind_the_album_is_not_settled() {
        let m = mapping(false, None, Some("2026-01-01T00:00:00.000Z"));
        // The album moved on and the cursor did not follow: there is still work to defer.
        assert!(!sync_status(&m, Some("2026-02-02T00:00:00.000Z"), 1).settled);
        // A mapping that never recorded a cursor at all is not settled either.
        assert!(!sync_status(&mapping(false, None, None), Some("2026-01-01T00:00:00.000Z"), 0).settled);
    }

    #[test]
    fn off_the_sync_path_an_absent_cursor_is_not_settled() {
        // Answering from state alone must be PESSIMISTIC: claiming settled with no cursor would
        // make a status probe lie to whoever is waiting on it.
        assert!(sync_status(&mapping(false, None, Some("v1")), None, 0).settled);
        assert!(!sync_status(&mapping(false, None, None), None, 0).settled);
    }

    #[test]
    fn a_failed_or_dead_mapping_is_never_settled() {
        let version = Some("v1");
        assert!(!sync_status(&mapping(false, Some(2), version), Some("v1"), 5).settled);
        assert!(!sync_status(&mapping(true, None, version), Some("v1"), 5).settled);
        assert_eq!(why_not_settled(&sync_status(&mapping(true, None, version), Some("v1"), 0)), "retired");
        assert_eq!(
            why_not_settled(&sync_status(&mapping(false, Some(3), version), Some("v1"), 0)),
            "failed cycles"
        );
        assert_eq!(
            why_not_settled(&sync_status(&mapping(false, None, None), Some("v1"), 0)),
            "refs deferred"
        );
    }

    #[test]
    fn the_cursor_never_moves_backwards_in_the_answer() {
        // `failCount` absent and zero mean the same thing on read.
        assert_eq!(sync_status(&mapping(false, None, Some("v1")), Some("v1"), 0).fail_count, 0);
        assert_eq!(sync_status(&mapping(false, Some(0), Some("v1")), Some("v1"), 0).fail_count, 0);
    }

    #[test]
    fn the_loop_tick_counters_move_independently() {
        let (w0, i0, c0) = loop_ticks();
        record_loop_tick(LoopName::Invites);
        let (w1, i1, c1) = loop_ticks();
        assert_eq!(w1, w0, "the watcher did not tick");
        assert_eq!(i1, i0 + 1);
        assert_eq!(c1, c0);
    }
}
