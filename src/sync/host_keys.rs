/** sync/host_keys.rs — the API key of the account a mapping's album is owned and read by. See ARCHITECTURE.md. */
use crate::state::State;
use crate::store::Mapping;

/// The key of the stand-in that OWNS a mapping's mirror: the account a mirror is read, written to
/// and deleted as. `None` for a mapping with no host slug (an owner mapping — a human's own album)
/// and for a mirror whose stand-in has no key minted yet. Whether `None` REFUSES the caller or is
/// silently fallen back from is the call site's decision, and must be visible there.
pub fn host_key_of(state: &State, mapping: &Mapping) -> Option<String> {
    mapping
        .host_slug
        .as_deref()
        .and_then(|slug| contributor_api_key(state, slug))
}

/// The key of the contributor a slug names. `None` when the slug names nothing, or the account
/// exists but has no key yet.
pub fn contributor_api_key(state: &State, slug: &str) -> Option<String> {
    state
        .collections()
        .contributors
        .get(slug)
        .and_then(|c| c.api_key.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Contributor;

    #[test]
    fn the_host_key_is_the_owning_standin_key_and_none_without_one() {
        let s = test_state();
        let mut mapping = fixture_mapping();
        mapping.host_slug = Some("person-owner".into());
        s.collections().contributors.insert(
            "person-owner".into(),
            Contributor {
                user_id: Some("u1".into()),
                api_key: Some("key-1".into()),
                password: None,
                avatar_done: false,
                via_peer: None,
                peer_user_id: None,
                home_peer: None,
            },
        );
        assert_eq!(host_key_of(&s, &mapping).as_deref(), Some("key-1"));
        // No host slug means no stand-in owns the album (an owner mapping): the answer is None,
        // and the caller refuses or falls back — visibly, at its own line.
        mapping.host_slug = None;
        assert_eq!(host_key_of(&s, &mapping), None);
        // A slug naming nothing, or an account with no key yet, is the same None.
        mapping.host_slug = Some("person-unknown".into());
        assert_eq!(host_key_of(&s, &mapping), None);
        s.collections().contributors.insert(
            "person-keyless".into(),
            Contributor {
                user_id: Some("u2".into()),
                api_key: None,
                password: None,
                avatar_done: false,
                via_peer: None,
                peer_user_id: None,
                home_peer: None,
            },
        );
        mapping.host_slug = Some("person-keyless".into());
        assert_eq!(host_key_of(&s, &mapping), None, "no key minted yet");
    }

    fn test_state() -> State {
        crate::state::State::for_test(
            crate::store::Store::open_in_memory().expect("in-memory store"),
        )
    }

    fn fixture_mapping() -> Mapping {
        Mapping {
            id: "m1".into(),
            role: crate::store::Role::Member,
            album_id: "mirror-1".into(),
            album_name: "Holidays".into(),
            peer: "peer-a".into(),
            remote_album_id: Some("origin-album".into()),
            remote_mapping_id: None,
            permissions: "view".into(),
            host_slug: None,
            via: "invite".into(),
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
}
