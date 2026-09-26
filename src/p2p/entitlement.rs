/** p2p/entitlement.rs — what a peer may READ, as distinct from who it is. See ARCHITECTURE.md. */
use crate::state::State;
use crate::store::Role;

/// Live mappings that face this peer, EITHER role: a member relays its own contributions back to
/// the origin, so member mappings grant reads too. Filtering on `role == Owner` here would break
/// contribution relay.
pub fn mappings_facing(state: &State, peer_pub: &str) -> Vec<String> {
    state
        .collections()
        .mappings
        .iter()
        .filter(|m| m.peer == peer_pub && !m.dead)
        .map(|m| m.id.clone())
        .collect()
}

/// Record assets we have advertised to a mapping's peer. Safe to call repeatedly.
pub fn record_offered(state: &State, mapping_id: &str, asset_ids: &[String]) {
    let ids: Vec<String> = asset_ids
        .iter()
        .filter(|a| !a.is_empty())
        .cloned()
        .collect();
    if !ids.is_empty() {
        let _ = state.store.offered_add(mapping_id, &ids);
    }
}

/// Record a manifest's worth of refs, each of which carries the ORIGIN asset id.
pub fn record_offered_refs(
    state: &State,
    mapping_id: &str,
    refs: &[crate::immich::refs::AssetRef],
) {
    let ids: Vec<String> = refs.iter().map(|r| r.origin_asset.clone()).collect();
    record_offered(state, mapping_id, &ids);
}

/// May this peer read this local asset's bytes? Exactly the offered index, nothing else.
///
/// The connection proved WHICH peer is calling; it says nothing about what they may see, and the
/// byte routes serve from the local Immich with the admin key — so identity alone would let any
/// enrolled peer read anything in the library it could name.
///
/// There is deliberately NO fallback that re-derives access from Immich on a miss: a second, looser
/// oracle would grant an album wholesale (including the assets the manifest deliberately excludes)
/// and would silently undo per-photo revocation on the next cache miss.
pub fn peer_may_read(state: &State, peer_pub: &str, asset_id: &str) -> bool {
    let mappings = mappings_facing(state, peer_pub);
    if mappings.is_empty() {
        return false;
    }
    state
        .store
        .offered_allows(&mappings, asset_id)
        .unwrap_or(false)
}

/// Drop a mapping's entitlements — called wherever its ledger is dropped.
pub fn forget_offered(state: &State, mapping_id: &str) {
    let _ = state.store.offered_remove_mapping(mapping_id);
}

/// Does this server know the peer at all?
pub fn is_enrolled(state: &State, peer_pub: &str) -> bool {
    state
        .collections()
        .peers
        .iter()
        .any(|p| p.pub_key == peer_pub)
}

/// Whether any mapping of ours is a live owner share to this peer.
pub fn has_owner_mapping(state: &State, peer_pub: &str) -> bool {
    state
        .collections()
        .mappings
        .iter()
        .any(|m| m.peer == peer_pub && m.role == Role::Owner && !m.dead)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Mapping, Store};
    use std::sync::Arc;

    fn mapping(peer: &str, role: Role, dead: bool, id: &str) -> Mapping {
        Mapping {
            id: id.into(),
            role,
            album_id: "a1".into(),
            album_name: "Holidays".into(),
            peer: peer.into(),
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

    /// Each test gets its OWN state, which is the point of passing it in: the process-wide one can
    /// be installed once, so tests sharing it would see whichever ran first.
    fn state_with(mappings: Vec<Mapping>) -> Arc<State> {
        crate::config::install_test_config();
        let store = Store::open_in_memory().unwrap();
        store.state.lock().unwrap().mappings = mappings;
        Arc::new(State::for_test(store))
    }

    #[test]
    fn a_peer_with_no_mapping_may_read_nothing() {
        let s = state_with(vec![]);
        assert!(!peer_may_read(&s, "peer-a", "asset-1"));
        assert!(!peer_may_read(&s, "peer-a", ""));
    }

    #[test]
    fn a_dead_mapping_grants_nothing() {
        let s = state_with(vec![mapping("peer-a", Role::Owner, true, "m-dead")]);
        assert!(mappings_facing(&s, "peer-a").is_empty());
        assert!(!peer_may_read(&s, "peer-a", "asset-1"));
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn a_MEMBER_mapping_grants_reads_too_because_it_relays_contributions() {
        // Filtering to owner-only here would break the D <- origin <- contributor chain: the
        // origin's member mapping is what lets it fetch a contributor's photo onward.
        let s = state_with(vec![mapping("peer-a", Role::Member, false, "m-member")]);
        assert_eq!(mappings_facing(&s, "peer-a"), vec!["m-member".to_string()]);
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn only_an_OFFERED_asset_is_readable_even_when_enrolled() {
        let s = state_with(vec![mapping("peer-a", Role::Owner, false, "m1")]);
        // Enrolled, with a live mapping — and still nothing, because nothing was recorded.
        assert!(!peer_may_read(&s, "peer-a", "asset-1"));
        s.store.offered_add("m1", &["asset-1".to_string()]).unwrap();
        assert!(peer_may_read(&s, "peer-a", "asset-1"));
        // And an asset never offered stays unreadable: naming it is not enough.
        assert!(!peer_may_read(&s, "peer-a", "asset-2"));
    }

    #[test]
    fn another_peers_entitlement_does_not_leak_across() {
        let s = state_with(vec![
            mapping("peer-a", Role::Owner, false, "m-a"),
            mapping("peer-b", Role::Owner, false, "m-b"),
        ]);
        s.store
            .offered_add("m-a", &["asset-1".to_string()])
            .unwrap();
        assert!(peer_may_read(&s, "peer-a", "asset-1"));
        // peer-b is enrolled and has a live mapping, but the asset was offered to peer-a.
        assert!(!peer_may_read(&s, "peer-b", "asset-1"));
    }

    #[test]
    fn revocation_is_real_the_row_is_gone() {
        let s = state_with(vec![mapping("peer-a", Role::Owner, false, "m1")]);
        s.store.offered_add("m1", &["asset-1".to_string()]).unwrap();
        assert!(peer_may_read(&s, "peer-a", "asset-1"));
        s.store.offered_reconcile("m1", &[]).unwrap();
        assert!(
            !peer_may_read(&s, "peer-a", "asset-1"),
            "an asset that left the album loses its row"
        );
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn a_multi_mapping_peer_reads_what_ANY_of_its_mappings_was_offered() {
        // One peer can hold several mappings (two albums); an asset offered through either is
        // readable, which is what makes a re-shared photo work.
        let s = state_with(vec![
            mapping("peer-a", Role::Owner, false, "m1"),
            mapping("peer-a", Role::Owner, false, "m2"),
        ]);
        s.store.offered_add("m2", &["asset-9".to_string()]).unwrap();
        assert!(peer_may_read(&s, "peer-a", "asset-9"));
    }
}
