/** sync/sweeps.rs — the state of the background loops: held still, or working. See PORT.md. */
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// How long a hold waits for work already in flight. A cycle still running when the hold is
/// acknowledged can deliver a change AFTER it, which is the one thing the hold exists to rule out.
pub const SWEEP_DRAIN_MS: u64 = 15_000;
const DRAIN_POLL_MS: u64 = 50;

static PAUSED: AtomicBool = AtomicBool::new(false);

fn working() -> &'static Mutex<HashSet<&'static str>> {
    static SET: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Whether the loops are held still.
///
/// Only the LOOP SCHEDULERS read this: a nudge handler runs its own pull regardless, which is what
/// makes "it arrived with the sweeps held" a claim about the nudge rather than about a timer.
pub fn sweeps_are_paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}

/// Hold or release them — rig-only, and set back by whatever held them. Holding does not stop work
/// already in flight; `when_sweeps_idle` is how a caller waits that out.
pub fn set_sweeps_paused(value: bool) {
    PAUSED.store(value, Ordering::SeqCst);
}

/// Claim a sweep's slot, or `false` when it is already running — the overlap guard, kept in the
/// same place as the hold so "what the sweeps are doing" has ONE answer rather than one per loop.
/// A slow cycle (a large album, a slow peer) must not stack concurrent full scans; stampedes starve
/// the host Immich's own background jobs.
pub fn start_sweep(name: &'static str) -> bool {
    working().lock().unwrap().insert(name)
}

/// Release it. Safe to call for a sweep that never started.
pub fn finish_sweep(name: &'static str) {
    working().lock().unwrap().remove(name);
}

pub fn sweeps_are_idle() -> bool {
    working().lock().unwrap().is_empty()
}

/// Wait, bounded, for the sweeps in flight to finish. Answers whether they are idle now.
pub async fn when_sweeps_idle(budget_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    while std::time::Instant::now() < deadline {
        if sweeps_are_idle() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(DRAIN_POLL_MS)).await;
    }
    sweeps_are_idle()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This module IS process-global state, so its tests must not run concurrently: one test's
    /// `start_sweep` makes another's "nothing is running" false. `cargo test` runs them in
    /// parallel by default, which is what made this flaky.
    fn exclusive() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn the_slot_is_the_overlap_guard() {
        let _guard = exclusive();
        // The first claim wins; a second cycle while the first is running must not start.
        assert!(start_sweep("test-a"));
        assert!(!start_sweep("test-a"), "a running sweep cannot be claimed twice");
        finish_sweep("test-a");
        assert!(start_sweep("test-a"), "and is claimable again once finished");
        finish_sweep("test-a");
    }

    #[test]
    fn per_loop_slots_are_independent() {
        let _guard = exclusive();
        assert!(start_sweep("test-b"));
        assert!(start_sweep("test-c"), "a different loop is a different slot");
        finish_sweep("test-b");
        finish_sweep("test-c");
    }

    #[test]
    fn finishing_a_sweep_that_never_started_is_safe() {
        let _guard = exclusive();
        finish_sweep("test-never-started");
        assert!(sweeps_are_idle());
    }

    #[test]
    fn the_hold_is_idempotent_and_releasable() {
        let _guard = exclusive();
        set_sweeps_paused(true);
        assert!(sweeps_are_paused());
        set_sweeps_paused(true);
        assert!(sweeps_are_paused());
        set_sweeps_paused(false);
        assert!(!sweeps_are_paused());
    }

    // `exclusive()` is deliberately held across the awaits below: it is the test rig that keeps every
    // other test out of the sweep slots, which is the whole claim these two cases make.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn when_sweeps_idle_returns_at_once_when_nothing_is_running() {
        let _guard = exclusive();
        assert!(sweeps_are_idle(), "no other test can hold a slot while this one runs");
        let started = std::time::Instant::now();
        assert!(when_sweeps_idle(SWEEP_DRAIN_MS).await);
        assert!(started.elapsed().as_millis() < 100, "an idle rig must not wait out the budget");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn when_sweeps_idle_sees_a_finish_mid_wait() {
        let _guard = exclusive();
        assert!(start_sweep("test-d"));
        let waiter = tokio::spawn(async { when_sweeps_idle(SWEEP_DRAIN_MS).await });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        finish_sweep("test-d");
        assert!(waiter.await.unwrap(), "the wait ends when the sweep does, not at the deadline");
    }
}
