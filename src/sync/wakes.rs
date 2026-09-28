/** sync/wakes.rs — per-lane wake channels: a nudge says "sweep now", the timer is only the backstop. See docs/sync-loops.md. */
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Notify;

/// The background lanes a nudge can wake. The invites lane also carries directory sync, invite
/// detection, link-grant retirement and the album-index freshness checks, so a nudge to it covers
/// those too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Watch,
    Comments,
    Invites,
}

/// What ended a lane's wait. `Nudged` means someone said "look now"; `Backstop` means the slow
/// timer fired — a lost nudge still converges, which is the property the backstop exists for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    Nudged,
    Backstop,
}

/// The `Notify` permit is the whole mechanism, including the coalescing: `notify_one` stores ONE
/// permit when no waiter is registered, so ten nudges during one sweep leave exactly one
/// follow-up, consumed by the next `wait`. There is deliberately no mirrored "pending" flag — a
/// second copy of what the permit already says is state that can only ever disagree with it.
struct LaneWake {
    notify: Notify,
}

fn watch_wake() -> &'static LaneWake {
    static WAKE: OnceLock<LaneWake> = OnceLock::new();
    WAKE.get_or_init(|| LaneWake {
        notify: Notify::new(),
    })
}

fn comments_wake() -> &'static LaneWake {
    static WAKE: OnceLock<LaneWake> = OnceLock::new();
    WAKE.get_or_init(|| LaneWake {
        notify: Notify::new(),
    })
}

fn invites_wake() -> &'static LaneWake {
    static WAKE: OnceLock<LaneWake> = OnceLock::new();
    WAKE.get_or_init(|| LaneWake {
        notify: Notify::new(),
    })
}

fn lane_wake(lane: Lane) -> &'static LaneWake {
    match lane {
        Lane::Watch => watch_wake(),
        Lane::Comments => comments_wake(),
        Lane::Invites => invites_wake(),
    }
}

/// A nudge for a lane: release the waiter, or leave the one stored permit for it. Coalescing is
/// the permit itself — ten nudges during one sweep leave ONE follow-up, never a stampede.
pub fn wake(lane: Lane) {
    lane_wake(lane).notify.notify_one();
}

/// Wait for the lane's next trigger: a nudge, or the backstop timer — whichever first. A nudge
/// that arrived while the lane was sweeping is consumed here (the stored permit ends this wait
/// immediately), so it costs exactly one follow-up sweep; a nudge that never arrives costs one
/// backstop, which is the property the timer keeps.
pub async fn wait(lane: Lane, backstop: Duration) -> Wake {
    let notified = lane_wake(lane).notify.notified();
    tokio::select! {
        _ = tokio::time::sleep(backstop) => Wake::Backstop,
        _ = notified => Wake::Nudged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test for the whole contract because the lanes are process globals: parallel test
    // threads racing the same lane would test each other's wakes instead. Ordered sections,
    // each consuming what it wakes, so the contract stays deterministic start to finish.

    #[tokio::test]
    async fn a_wake_wakes_only_its_lane_coalesces_and_a_lost_wake_ends_at_the_backstop() {
        // A wake ends the wait immediately rather than at the backstop.
        let start = std::time::Instant::now();
        wake(Lane::Watch);
        let outcome = wait(Lane::Watch, Duration::from_secs(5)).await;
        assert_eq!(outcome, Wake::Nudged);
        assert!(start.elapsed() < Duration::from_secs(1));

        // Without a wake, the backstop ends the wait — the timer is the lost-nudge path.
        let start = std::time::Instant::now();
        let outcome = wait(Lane::Comments, Duration::from_millis(50)).await;
        assert_eq!(outcome, Wake::Backstop);
        assert!(start.elapsed() >= Duration::from_millis(45));

        // Nudges during a sweep coalesce into ONE follow-up: three wakes, one Nudged, the next
        // wait a Backstop — never a stampede.
        wake(Lane::Invites);
        wake(Lane::Invites);
        wake(Lane::Invites);
        let first = wait(Lane::Invites, Duration::from_secs(5)).await;
        assert_eq!(first, Wake::Nudged);
        let second = wait(Lane::Invites, Duration::from_millis(40)).await;
        assert_eq!(
            second,
            Wake::Backstop,
            "three nudges must cost one follow-up"
        );

        // Lanes are independent: waking one must not wake another.
        wake(Lane::Watch);
        let comments = wait(Lane::Comments, Duration::from_millis(40)).await;
        assert_eq!(
            comments,
            Wake::Backstop,
            "waking one lane must not wake another"
        );
        let watch = wait(Lane::Watch, Duration::from_secs(5)).await;
        assert_eq!(watch, Wake::Nudged);

        // A wake arriving between sweeps is not lost: the permit survives until the next wait.
        wake(Lane::Comments);
        wake(Lane::Comments);
        std::thread::sleep(Duration::from_millis(20));
        let outcome = wait(Lane::Comments, Duration::from_secs(5)).await;
        assert_eq!(outcome, Wake::Nudged);
    }
}
