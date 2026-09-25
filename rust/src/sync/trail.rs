/** sync/trail.rs — audit lines that wait for the album's owner. See PORT.md. */
use crate::immich::client::Client;
use crate::state::State;

/// Queue a line about an album we cannot write to yet.
///
/// Our bot can only be put on an album by someone who can already change it (Immich refuses the
/// household admin key: `400 Not found or no album.share access`). So a peer's join or leave — an
/// event that happens while the owner is elsewhere — is RECORDED here, and written the next time the
/// owner is in front of us with their own credential.
pub fn enqueue(state: &State, album_id: &str, mapping_id: &str, event: &str, text: &str) {
    if let Err(e) = state
        .store
        .trail_pending_add(album_id, mapping_id, event, text)
    {
        crate::log!("could not queue an audit line for {album_id}: {e}");
    }
}

/// Write whatever is waiting about albums this caller can write to, as them.
///
/// Called from the panel's own album read, which is precisely the moment we hold their credential
/// and the list of albums they own — no extra Immich call to find either. Best effort throughout:
/// a line that cannot be written stays queued for the next visit rather than being lost.
pub async fn drain_for_caller(
    state: &State,
    client: &Client,
    creds: &crate::immich::access::Creds,
    writable_album_ids: &[String],
) {
    // ONE drain at a time. A panel loads `/me/albums` on open and again on its own live hint, and two
    // drains reading the same queue both post the same line — a duplicated line in someone's album is
    // exactly what a trail must not produce. `try_lock` rather than `lock`: a visit that arrives while
    // another is draining has nothing to add, and waiting would hold the request open for it.
    static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let Ok(_draining) = GATE.try_lock() else {
        return;
    };
    let Ok(pending) = state.store.trail_pending_all() else {
        return;
    };
    for row in pending {
        if !writable_album_ids.iter().any(|id| id == &row.album_id) {
            continue;
        }
        // The membership first, and on THEIR credential: this is the act that lets our bot comment
        // on their album at all. A refusal leaves the row queued, which is the honest outcome — it
        // will be tried again next visit rather than half-written.
        if let Err(e) =
            crate::sync::house_bot::add_house_bot_to_album(state, client, &row.album_id, creds).await
        {
            // A refusal is usually an album that is gone, so this is bounded rather than retried on
            // every visit for ever — but it is still a RETRY, because a transient Immich failure
            // must not cost the album its history.
            match state.store.trail_pending_bump(row.id) {
                Ok(true) => crate::log!(
                    "giving up on an audit line for {} ({}) after {} tries: {e}",
                    &row.album_id[..row.album_id.len().min(8)],
                    row.event,
                    crate::store::TRAIL_MAX_ATTEMPTS
                ),
                _ => crate::log!(
                    "could not put the bot on {} to record a {}: {e}",
                    &row.album_id[..row.album_id.len().min(8)],
                    row.event
                ),
            }
            continue;
        }
        // The event carries the row id, so two joins to one album are two lines: `audit_line`'s tag
        // is keyed by event AND album, and a plain "joined" would suppress the second one for ever.
        let posted = crate::sync::audit::audit_line(
            state,
            client,
            &row.mapping_id,
            &row.album_id,
            &format!("{}:{}", row.event, row.id),
            &row.text,
        )
        .await;
        if posted {
            let _ = state.store.trail_pending_remove(row.id);
            let _ = state.save();
        } else {
            // The line could not be written. Bounded the same way, for the same reason.
            let _ = state.store.trail_pending_bump(row.id);
        }
    }
}

/// Shall we try at all? Cheap gate so a panel visit on a household with no history pays nothing.
pub fn has_pending(state: &State) -> bool {
    state.store.trail_pending_count().unwrap_or(0) > 0
}

/// The two peer-initiated events, so the wording lives in one place.
pub fn joined_text(household: &str) -> String {
    format!(
        "\"{household}\" joined this album through a share link — their photos appear here as they add them, and removing them later takes their photos back out."
    )
}

pub fn left_text(household: &str) -> String {
    format!(
        "\"{household}\" left this album — the photos they added have been taken back out, and this album is no longer shared with them."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    fn state() -> State {
        State::for_test(Store::open_in_memory().expect("in-memory store"))
    }

    #[test]
    fn a_queued_line_gives_up_after_a_few_tries_rather_than_for_ever() {
        // An album that is gone (deleted, or no longer visible to its owner) must not be asked about
        // on every visit for the rest of the install's life — but a transient failure must not cost
        // the album its history, so it is a RETRY with a bound rather than one attempt.
        let s = state();
        let id = s
            .store
            .trail_pending_add("album-gone", "m1", "left", "they left")
            .unwrap();
        for attempt in 1..crate::store::TRAIL_MAX_ATTEMPTS {
            assert!(!s.store.trail_pending_bump(id).unwrap(), "still worth asking (try {attempt})");
            assert_eq!(s.store.trail_pending_count().unwrap(), 1);
        }
        assert!(s.store.trail_pending_bump(id).unwrap(), "the last try gives up");
        assert_eq!(s.store.trail_pending_count().unwrap(), 0, "and the row is gone");
    }

    #[test]
    fn a_line_waits_until_its_album_is_the_callers_to_write() {
        let s = state();
        assert!(!has_pending(&s), "nothing queued costs nothing");
        enqueue(&s, "album-a", "m1", "joined", &joined_text("Mock household (C)"));
        enqueue(&s, "album-b", "m2", "left", &left_text("Demo household (B)"));
        assert!(has_pending(&s));
        assert_eq!(s.store.trail_pending_count().unwrap(), 2);
        let rows = s.store.trail_pending_all().unwrap();
        // Oldest first, so a trail reads in the order things happened.
        assert_eq!(rows[0].album_id, "album-a");
        assert_eq!(rows[0].event, "joined");
        assert_eq!(rows[1].album_id, "album-b");
        // The row id is what the eventual tag carries, so the two never collide.
        assert_ne!(rows[0].id, rows[1].id);
    }
}
