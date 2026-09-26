/** sync/peer_mapping_id.rs — the ids peers address albums by, and the peer/id lookups around them. See ARCHITECTURE.md. */
use crate::state::State;
use crate::store::{Mapping, Peer, Role};

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
/// The remote id a member mirror is addressed by: `remote_mapping_id` — the id the ORIGIN minted —
/// preferred, with `remote_album_id` for a protocol-2 peer that predates it. `None` when neither
/// exists or the stored id is empty: a caller must REFUSE rather than address an album nobody
/// offered.
pub fn remote_target(mapping: &Mapping) -> Option<String> {
    mapping
        .remote_mapping_id
        .clone()
        .filter(|id| !id.is_empty())
        .or_else(|| mapping.remote_album_id.clone().filter(|id| !id.is_empty()))
}

pub fn peer_album_mapping_id(mapping: &Mapping) -> String {
    if mapping.role == Role::Member {
        remote_target(mapping).unwrap_or_default()
    } else {
        mapping.album_id.clone()
    }
}

/// The peer a pub_key names, or `None` when it is not linked. Standalone lookups only: a caller
/// already holding a `collections()` guard must use it, because taking the guard twice on one
/// thread deadlocks by design (see `state.rs`).
pub fn peer_of(state: &State, pub_key: &str) -> Option<Peer> {
    state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == pub_key)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapping(
        role: Role,
        album: &str,
        remote_mapping: Option<&str>,
        remote_album: Option<&str>,
    ) -> Mapping {
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
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn our_OWN_album_is_addressed_by_our_album_id() {
        // Even when the mapping carries the peer's mirror ids: naming our album with one of those
        // would write to a mapping that is not ours.
        let m = mapping(
            Role::Owner,
            "our-album",
            Some("their-mirror"),
            Some("their-album"),
        );
        assert_eq!(peer_album_mapping_id(&m), "our-album");
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn a_MIRROR_is_addressed_by_the_id_the_origin_minted() {
        let m = mapping(
            Role::Member,
            "our-mirror",
            Some("origin-mapping"),
            Some("origin-album"),
        );
        assert_eq!(peer_album_mapping_id(&m), "origin-mapping");
    }

    #[test]
    fn a_mirror_with_no_remote_mapping_falls_back_to_the_remote_album() {
        // A protocol-2 peer that predates remote mapping ids.
        let m = mapping(Role::Member, "our-mirror", None, Some("origin-album"));
        assert_eq!(peer_album_mapping_id(&m), "origin-album");
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn a_mirror_with_neither_is_EMPTY_so_the_caller_refuses_rather_than_guesses() {
        let m = mapping(Role::Member, "our-mirror", None, None);
        assert_eq!(peer_album_mapping_id(&m), "");
        assert!(peer_album_mapping_id(&m).is_empty());
    }

    #[test]
    fn remote_target_prefers_the_id_the_origin_minted() {
        let m = mapping(
            Role::Member,
            "our-mirror",
            Some("origin-mapping"),
            Some("origin-album"),
        );
        assert_eq!(remote_target(&m).as_deref(), Some("origin-mapping"));
    }

    #[test]
    fn remote_target_falls_back_to_the_remote_album_for_older_peers() {
        let m = mapping(Role::Member, "our-mirror", None, Some("origin-album"));
        assert_eq!(remote_target(&m).as_deref(), Some("origin-album"));
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn remote_target_is_NONE_when_neither_id_exists_so_the_caller_refuses() {
        let m = mapping(Role::Member, "our-mirror", None, None);
        assert_eq!(remote_target(&m), None);
        // An EMPTY stored id is not an address either — the same refusal, not a malformed path.
        let m = mapping(Role::Member, "our-mirror", Some(""), None);
        assert_eq!(remote_target(&m), None, "an empty id addresses nothing");
    }

    #[test]
    fn peer_of_finds_the_peer_by_its_public_key_and_none_when_unknown() {
        let s = crate::state::State::for_test(
            crate::store::Store::open_in_memory().expect("in-memory store"),
        );
        let mut peer = fixture_peer("pk-1");
        peer.name = "Their household".into();
        s.collections().peers.push(peer.clone());
        assert_eq!(
            peer_of(&s, "pk-1").map(|p| p.name),
            Some("Their household".to_string())
        );
        assert_eq!(
            peer_of(&s, "pk-missing"),
            None,
            "an unknown key is not a peer"
        );
    }

    fn fixture_peer(pub_key: &str) -> Peer {
        Peer {
            pub_key: pub_key.into(),
            name: pub_key.into(),
            version: None,
            protocol: None,
            features: None,
            via: "link".into(),
            first_seen_at: "2026-01-01T00:00:00.000Z".into(),
            relay_hint: None,
            last_addrs: None,
        }
    }
}
