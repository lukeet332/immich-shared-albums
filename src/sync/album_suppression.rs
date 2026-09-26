/** sync/album_suppression.rs — refusing to materialise a photo the album already holds. See ARCHITECTURE.md. */
use crate::store::{Mapping, SeenEntry};

/// The mappings whose local half IS this album — the set a duplicate could arrive through.
///
/// A dead mapping is excluded. Its ledger rows outlive it, and honouring one would suppress a photo
/// on the word of a share nothing is serving any more: the album would be left without it.
pub fn mappings_sharing_album(album_id: &str, mappings: &[Mapping]) -> Vec<String> {
    mappings
        .iter()
        .filter(|m| m.album_id == album_id && !m.dead)
        .map(|m| m.id.clone())
        .collect()
}

/// The row saying this album already holds this photo, materialised through some mapping.
///
/// A 3-way mesh can offer one photo through two shares that land on the same album, and each would
/// otherwise materialise its own stub: the bytes differ by a random tail, so Immich cannot collapse
/// the second into the first and the album would show the photo twice. Scoped to the ALBUM on
/// purpose — the same photo in two different albums is the ordinary case, not a duplicate.
pub fn existing_copy_in_album(
    album_id: &str,
    checksum: &str,
    mappings: &[Mapping],
    rows: &[SeenEntry],
) -> Option<SeenEntry> {
    let sharing = mappings_sharing_album(album_id, mappings);
    rows.iter()
        .find(|r| r.checksum == checksum && sharing.iter().any(|id| id == &r.mapping))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Role;

    fn mapping(id: &str, album_id: &str) -> Mapping {
        mapping_with(id, album_id, false)
    }

    fn mapping_with(id: &str, album_id: &str, dead: bool) -> Mapping {
        Mapping {
            id: id.into(),
            role: Role::Member,
            album_id: album_id.into(),
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
            fail_count: None,
            local_version: None,
            remote_version: None,
            comment_count: None,
            remote_comment_count: None,
        }
    }

    fn row(mapping: &str, checksum: &str) -> SeenEntry {
        SeenEntry {
            mapping: mapping.into(),
            checksum: checksum.into(),
            local_asset: "asset-1".into(),
            origin_asset: Some("origin-1".into()),
            stored_full: false,
        }
    }

    #[test]
    fn the_mappings_sharing_an_album_are_exactly_the_ones_whose_local_half_is_that_album() {
        let ids = mappings_sharing_album(
            "album-1",
            &[mapping("m1", "album-1"), mapping("m2", "album-2")],
        );
        assert_eq!(ids, vec!["m1".to_string()]);
    }

    #[test]
    fn a_dead_mapping_is_not_asked_because_its_rows_outlive_it() {
        // Honouring a dead mapping's row would suppress a photo on the word of a share nothing is
        // serving any more, leaving the album without it.
        let ids = mappings_sharing_album("album-1", &[mapping_with("m1", "album-1", true)]);
        assert!(ids.is_empty());
    }

    #[test]
    fn a_copy_another_mapping_already_put_in_the_same_album_is_found() {
        // The case this module exists for: a 3-way mesh offers ONE photo through two shares that
        // land on the same album, and each would otherwise materialise its own stub — because the
        // bytes differ by a random tail, Immich cannot collapse them, and the album shows it twice.
        let found = existing_copy_in_album(
            "album-1",
            "summer.jpg",
            &[mapping("m1", "album-1"), mapping("m2", "album-1")],
            &[row("m1", "summer.jpg")],
        );
        assert_eq!(found.map(|r| r.local_asset), Some("asset-1".to_string()));
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn a_row_from_a_mapping_of_ANOTHER_album_does_not_suppress() {
        // The same photo in two different albums is the ordinary case, not a duplicate.
        let found = existing_copy_in_album(
            "album-1",
            "summer.jpg",
            &[mapping("m1", "album-2")],
            &[row("m1", "summer.jpg")],
        );
        assert!(found.is_none());
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn a_row_from_a_DEAD_mapping_of_the_same_album_does_not_suppress() {
        let found = existing_copy_in_album(
            "album-1",
            "summer.jpg",
            &[mapping_with("m1", "album-1", true)],
            &[row("m1", "summer.jpg")],
        );
        assert!(found.is_none());
    }

    #[test]
    fn a_different_checksum_is_not_suppressed() {
        let found = existing_copy_in_album(
            "album-1",
            "winter.jpg",
            &[mapping("m1", "album-1")],
            &[row("m1", "summer.jpg")],
        );
        assert!(found.is_none(), "a different photo is a different photo");
    }

    #[test]
    fn with_no_rows_nothing_is_suppressed() {
        let found =
            existing_copy_in_album("album-1", "summer.jpg", &[mapping("m1", "album-1")], &[]);
        assert!(found.is_none());
    }

    #[test]
    fn the_found_row_keeps_its_stored_full_flag() {
        // `materialiseRef` carries this onto the new mapping's row, so a full local copy stays a
        // full local copy rather than silently becoming a stub.
        let mut full = row("m1", "summer.jpg");
        full.stored_full = true;
        let found = existing_copy_in_album(
            "album-1",
            "summer.jpg",
            &[mapping("m1", "album-1")],
            &[full],
        );
        assert!(found.unwrap().stored_full);
    }
}
