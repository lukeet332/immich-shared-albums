/** sync/peer_mapping_id.rs — the id a peer addresses the album behind a mapping by. See ARCHITECTURE.md. */
use crate::store::{Mapping, Role};

/// What a peer's routes mean when they name this mapping's album (`/albums/:id/refs`, `/comments`).
///
/// Two different ids answer to that name, and which is right depends on which side owns the album.
/// A mirror WE hold is addressed by the id the ORIGIN minted for it — `remote_mapping_id`, the
/// origin's own mapping, with `remote_album_id` for a protocol-2 peer that predates it. Our OWN
/// album is addressed by our album id: this mapping may carry the peer's mirror ids too, and naming
/// our album with one of those would write to a mapping that is not ours.
///
/// Empty when a member mirror has neither remote id: a caller must REFUSE rather than guess, because
/// every guess here addresses an album nobody offered.
pub fn peer_album_mapping_id(mapping: &Mapping) -> String {
    if mapping.role == Role::Member {
        mapping
            .remote_mapping_id
            .clone()
            .or_else(|| mapping.remote_album_id.clone())
            .unwrap_or_default()
    } else {
        mapping.album_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(role: Role, album: &str, remote_mapping: Option<&str>, remote_album: Option<&str>) -> Mapping {
        Mapping {
            id: "m1".into(),
            role,
            album_id: album.into(),
            album_name: "Holidays".into(),
            peer: "peer-a".into(),
            remote_album_id: remote_album.map(str::to_string),
            remote_mapping_id: remote_mapping.map(str::to_string),
            permissions: "contribute".into(),
            host_slug: None,
            via: "link".into(),
            for_peer_user_ids: None,
            album_owner_name: None,
            album_owner_id: None,
            adopted: None,
            reunified: None,
            dead: false,
            dead_at: None,
            dead_reason: None,
            fail_count: None,
            local_version: None,
            remote_version: None,
            comment_count: None,
            remote_comment_count: None,
        }
    }

    #[test]
    fn our_OWN_album_is_addressed_by_our_album_id() {
        // Even when the mapping carries the peer's mirror ids: naming our album with one of those
        // would write to a mapping that is not ours.
        let m = mapping(Role::Owner, "our-album", Some("their-mirror"), Some("their-album"));
        assert_eq!(peer_album_mapping_id(&m), "our-album");
    }

    #[test]
    fn a_MIRROR_is_addressed_by_the_id_the_origin_minted() {
        let m = mapping(Role::Member, "our-mirror", Some("origin-mapping"), Some("origin-album"));
        assert_eq!(peer_album_mapping_id(&m), "origin-mapping");
    }

    #[test]
    fn a_mirror_with_no_remote_mapping_falls_back_to_the_remote_album() {
        // A protocol-2 peer that predates remote mapping ids.
        let m = mapping(Role::Member, "our-mirror", None, Some("origin-album"));
        assert_eq!(peer_album_mapping_id(&m), "origin-album");
    }

    #[test]
    fn a_mirror_with_neither_is_EMPTY_so_the_caller_refuses_rather_than_guesses() {
        let m = mapping(Role::Member, "our-mirror", None, None);
        assert_eq!(peer_album_mapping_id(&m), "");
        assert!(peer_album_mapping_id(&m).is_empty());
    }
}
