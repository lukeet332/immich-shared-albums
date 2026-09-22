//! sync/index_offer.rs — when a person's albums are worth offering to a peer again. See PORT.md.

use crate::store::OwnedAlbum;

/// How long one refresh stands for.
///
/// A person's album list cannot change without them using Immich, and using Immich through this
/// sidecar is what starts the next session — so the first request after this much quiet is the moment
/// the list may have moved, and the rest of that session costs nothing. Measured from the last
/// request, not the last refresh: a session that keeps talking never re-reads.
pub const SESSION_QUIET_MS: i64 = 15 * 60 * 1000;

/// The window between refreshes, and the bounds it moves between.
pub const OFFER_BASE_MS: i64 = 60 * 1000;
pub const OFFER_MAX_MS: i64 = 15 * 60 * 1000;

/// Whether a request at `now` opens a session for this credential.
pub fn opens_session(last_visit_at: i64, now: i64) -> bool {
    now - last_visit_at >= SESSION_QUIET_MS
}

/// Did what this person offers change?
///
/// Compared on the fields matching READS, because those fields ARE the match: a rename, a new photo or
/// a new album all change what a peer can pair with, and a peer told "look again" pays a dial. Order
/// is not a change.
pub fn index_changed(before: &[OwnedAlbum], after: &[OwnedAlbum]) -> bool {
    fn key(album: &OwnedAlbum) -> String {
        format!(
            "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
            album.name,
            album.asset_count,
            album.start_date.as_deref().unwrap_or(""),
            album.end_date.as_deref().unwrap_or(""),
            album.owner_name
        )
    }
    if before.len() != after.len() {
        return true;
    }
    let was: std::collections::HashSet<String> = before.iter().map(key).collect();
    after.iter().any(|album| !was.contains(&key(album)))
}

/// The window after this many consecutive refreshes that found nothing.
///
/// The window is a COST decision and the cost is the payload: reading a person's album list is one
/// call whose size grows with their library, so a fixed fast cadence spends the same money on a
/// library nobody touches as on one being built. Silence doubles the wait up to the cap; any change
/// drops it straight back to the base.
pub fn offer_window_ms(refreshes_with_no_change: u32) -> i64 {
    let doubled = OFFER_BASE_MS.saturating_mul(1i64.checked_shl(refreshes_with_no_change.min(31)).unwrap_or(i64::MAX));
    doubled.min(OFFER_MAX_MS)
}

/// Whether a request at `now` should read this person's albums again.
pub fn should_refresh(last_visit_at: i64, last_refresh_at: i64, refreshes_with_no_change: u32, now: i64) -> bool {
    if opens_session(last_visit_at, now) {
        return true;
    }
    now - last_refresh_at >= offer_window_ms(refreshes_with_no_change)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn album(name: &str, asset_count: i64) -> OwnedAlbum {
        OwnedAlbum {
            name: name.to_string(),
            asset_count,
            start_date: Some("2024-06-10T00:00:00.000Z".into()),
            end_date: Some("2024-08-11T00:00:00.000Z".into()),
            owner_user_id: Some("u-nan".into()),
            owner_name: "Demo Nan".into(),
        }
    }

    #[test]
    fn the_first_request_with_nothing_seen_before_opens_a_session() {
        assert!(opens_session(0, 1_700_000_000_000), "a person never seen has never been read");
    }

    #[test]
    fn a_request_in_the_middle_of_a_session_does_not_read_again() {
        let now = 1_700_000_000_000;
        assert!(!opens_session(now - 1_000, now), "one second later is the same session");
        assert!(!opens_session(now - (SESSION_QUIET_MS - 1), now), "one millisecond short is still it");
        assert!(opens_session(now - SESSION_QUIET_MS, now), "exactly the quiet period counts");
        assert!(opens_session(now - SESSION_QUIET_MS * 4, now), "hours away is certainly a new one");
    }

    #[test]
    fn an_unchanged_list_tells_no_peer_to_look_again() {
        assert!(!index_changed(&[album("Summer 2024", 6)], &[album("Summer 2024", 6)]));
        // Immich does not promise an order.
        assert!(!index_changed(
            &[album("Summer 2024", 6), album("Winter 2023", 2)],
            &[album("Winter 2023", 2), album("Summer 2024", 6)]
        ));
    }

    #[test]
    fn a_new_renamed_grown_or_withdrawn_album_is_a_change() {
        assert!(index_changed(&[album("Summer 2024", 6)], &[album("Summer 2024", 6), album("Winter 2023", 2)]));
        assert!(index_changed(&[album("Summer 2024", 6)], &[album("Summer 2024", 7)]), "the count is what a peer prints");
        assert!(index_changed(&[album("Summer 2024", 6)], &[album("Summer 2024 (edited)", 6)]));
        assert!(index_changed(&[album("Summer 2024", 6)], &[]), "the peer must stop matching against it");
    }

    #[test]
    fn a_window_with_no_evidence_of_change_backs_off_and_stops_at_the_cap() {
        assert_eq!(offer_window_ms(0), OFFER_BASE_MS, "the first look after a change is a minute");
        assert_eq!(offer_window_ms(1), OFFER_BASE_MS * 2);
        assert_eq!(offer_window_ms(2), OFFER_BASE_MS * 4);
        assert_eq!(offer_window_ms(3), OFFER_BASE_MS * 8);
        assert_eq!(offer_window_ms(4), OFFER_MAX_MS, "the cap bounds an idle library");
        assert_eq!(offer_window_ms(50), OFFER_MAX_MS, "and it stays bounded however long the silence");
    }

    #[test]
    fn a_refresh_is_due_only_once_its_window_has_elapsed() {
        let now = 1_700_000_000_000;
        assert!(!should_refresh(now - 1_000, now, 3, now + offer_window_ms(3) - 1), "one millisecond short");
        assert!(should_refresh(now - 1_000, now, 3, now + offer_window_ms(3)), "the window is the whole wait");
    }

    #[test]
    fn a_backed_off_person_who_comes_back_is_read_at_once() {
        let now = 1_700_000_000_000;
        assert!(
            should_refresh(now - SESSION_QUIET_MS, now - 1_000, 9, now),
            "returning is evidence: the list may have moved while nobody was talking"
        );
    }

    #[test]
    fn a_change_drops_the_window_back_to_the_base_so_work_is_followed_closely() {
        let now = 1_700_000_000_000;
        assert!(should_refresh(now - 1_000, now, 0, now + OFFER_BASE_MS));
        assert!(!should_refresh(now - 1_000, now, 4, now + OFFER_BASE_MS));
    }
}
