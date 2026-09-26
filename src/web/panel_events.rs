/** web/panel_events.rs — the hint channel to panels that are open. See ARCHITECTURE.md. */
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// What a panel may be told about. A HINT, never content: the subscriber re-reads its own
/// caller-scoped data, so a hint can never become a source and a panel can never be shown something
/// it is not allowed to read for itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelEvent {
    Invitations,
    Index,
    Shares,
}

impl PanelEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            PanelEvent::Invitations => "invitations",
            PanelEvent::Index => "index",
            PanelEvent::Shares => "shares",
        }
    }

    /// The wire names, and the only ones `/test/emit` accepts.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "invitations" => Some(PanelEvent::Invitations),
            "index" => Some(PanelEvent::Index),
            "shares" => Some(PanelEvent::Shares),
            _ => None,
        }
    }
}

/// How many hints this process has emitted. Observability only — an open panel must not be able to
/// make the server hint at it in a loop, and a count is the only way to see that from outside.
static HINTS_EMITTED: AtomicU64 = AtomicU64::new(0);

/// Every panel currently listening, keyed by its subscription id. The count IS the map's length:
/// a second counter could only ever drift from it.
static SUBSCRIBERS: OnceLock<Mutex<HashMap<u64, UnboundedSender<PanelEvent>>>> = OnceLock::new();
static NEXT_SUBSCRIPTION_ID: AtomicU64 = AtomicU64::new(1);

fn subscribers() -> &'static Mutex<HashMap<u64, UnboundedSender<PanelEvent>>> {
    SUBSCRIBERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How many panels are listening. The rig asserts a panel is connected before it changes anything,
/// so a passing test cannot be one that had nobody to notify.
pub fn panel_count() -> usize {
    // A POISONED lock is not an empty channel: it means a subscriber panicked mid-dispatch, and the
    // set behind it is still perfectly usable — so the guard is recovered rather than read as 0.
    subscribers()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .len()
}

pub fn hints_emitted() -> u64 {
    HINTS_EMITTED.load(Ordering::Relaxed)
}

/// One panel's open connection.
///
/// Dropping it is the unsubscribe: axum drops the response body's stream when the client goes away,
/// and a socket that closed must not leave a sender behind that the next hint writes into.
pub struct Subscription {
    id: u64,
    events: UnboundedReceiver<PanelEvent>,
}

impl Subscription {
    pub async fn next(&mut self) -> Option<PanelEvent> {
        self.events.recv().await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut open = subscribers().lock().unwrap_or_else(|p| p.into_inner());
        open.remove(&self.id);
        crate::log!("panel stopped following events ({} open)", open.len());
    }
}

pub fn subscribe() -> Subscription {
    let (sender, events) = unbounded_channel();
    let id = NEXT_SUBSCRIPTION_ID.fetch_add(1, Ordering::Relaxed);
    let mut open = subscribers().lock().unwrap_or_else(|p| p.into_inner());
    open.insert(id, sender);
    let count = open.len();
    crate::log!("panel following events ({count} open)");
    Subscription { id, events }
}

/// Tell every open panel that something it displays may have changed.
pub fn emit(event: PanelEvent) {
    HINTS_EMITTED.fetch_add(1, Ordering::Relaxed);
    // ONE acquisition, and the guard is released before the log: taking this lock twice in one call
    // is the shape that has deadlocked this port before. The guard is recovered from poison rather
    // than dropped: a subscriber panicking mid-dispatch does not unsign the others.
    let watching = {
        let open = subscribers().lock().unwrap_or_else(|p| p.into_inner());
        for sender in open.values() {
            // A closed socket is not the emitter's problem; its drop unsubscribes it.
            let _ = sender.send(event);
        }
        open.len()
    };
    if watching > 0 {
        crate::log!("panel hint \"{}\" → {watching} watching", event.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hint reaches an open panel, and a closed one stops counting.
    ///
    /// The rig asserts the same property from outside (`/test/emit` answers how many panels are
    /// listening); this is the part that can be checked without a socket.
    #[test]
    fn a_hint_reaches_every_watching_panel_and_a_dropped_one_stops_watching() {
        let baseline = panel_count();
        let mut first = subscribe();
        let mut second = subscribe();
        assert_eq!(panel_count(), baseline + 2);
        emit(PanelEvent::Shares);
        assert_eq!(
            futures_lite::future::block_on(first.next()),
            Some(PanelEvent::Shares),
            "the first panel hears it"
        );
        assert_eq!(
            futures_lite::future::block_on(second.next()),
            Some(PanelEvent::Shares),
            "and so does the second"
        );
        drop(first);
        assert_eq!(
            panel_count(),
            baseline + 1,
            "dropping a panel unsubscribes it"
        );
        emit(PanelEvent::Index);
        assert_eq!(
            futures_lite::future::block_on(second.next()),
            Some(PanelEvent::Index)
        );
    }

    #[test]
    fn the_wire_names_are_the_only_ones_parse_accepts() {
        assert_eq!(
            PanelEvent::parse("invitations"),
            Some(PanelEvent::Invitations)
        );
        assert_eq!(PanelEvent::parse("index"), Some(PanelEvent::Index));
        assert_eq!(PanelEvent::parse("shares"), Some(PanelEvent::Shares));
        assert_eq!(PanelEvent::parse("albums"), None);
    }
}
