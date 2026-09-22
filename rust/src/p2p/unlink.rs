/** p2p/unlink.rs — what the panel shows for a linked server, and what an unlink tears down. See PORT.md. */
use crate::config::{bot_prefix, cfg};
use crate::immich::client::Client;
use crate::state::State;
use crate::store::Role;
use serde_json::{json, Value};

/// What an unlink did, as the panel reports it.
pub struct UnlinkResult {
    pub household: String,
    pub mirrors_removed: usize,
    pub shares_revoked: usize,
    pub markers_removed: usize,
}

/// Sever a link, and everything it brought with it.
///
/// The `unlinking` window is held for the whole operation: a directory sync or a materialise running
/// concurrently would otherwise see a peer mid-teardown and either re-create what is being removed
/// or refuse work for a link that still looks live.
pub async fn unlink_peer(
    state: &State,
    client: &Client,
    pub_key: &str,
) -> Result<UnlinkResult, String> {
    state.mark_unlinking(pub_key);
    let outcome = unlink_peer_now(state, client, pub_key).await;
    state.clear_unlinking(pub_key);
    outcome
}

async fn unlink_peer_now(
    state: &State,
    client: &Client,
    pub_key: &str,
) -> Result<UnlinkResult, String> {
    let Some(peer) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == pub_key)
        .cloned()
    else {
        return Err("unknown household".to_string());
    };
    let household = peer.name.clone();
    let mut mirrors_removed = 0usize;
    let mut shares_revoked = 0usize;
    let mut markers_removed = 0usize;

    // COPY the ids first: `leave_album` splices `state.mappings`, so iterating it live would skip
    // whichever mapping slid into the vacated slot.
    let ids: Vec<(String, Role)> = state
        .collections()
        .mappings
        .iter()
        .filter(|m| m.peer == pub_key)
        .map(|m| (m.id.clone(), m.role))
        .collect();
    for (id, role) in ids {
        if role == Role::Member {
            // `notify_origin: false` — the link is being severed, so telling the origin we left
            // would be a message to a household we are no longer speaking to.
            match crate::sync::leave::leave_album(state, client, &id, false).await {
                Ok(_) => mirrors_removed += 1,
                Err(e) => crate::log!("unlink: could not remove a mirror: {e}"),
            }
            continue;
        }
        crate::p2p::entitlement::forget_offered(state, &id);
        let _ = state.store.seen_act_remove_mapping(&id);
        let before = state.collections().mappings.len();
        state.collections().mappings.retain(|m| m.id != id);
        if state.collections().mappings.len() < before {
            shares_revoked += 1;
        }
    }

    // Delete this peer's people, and their photos go with them.
    //
    // Everything these accounts own is a PROXY: a stub whose real bytes stream from the peer on
    // demand. Once the link is gone those bytes are unreachable, so keeping the assets would leave
    // broken thumbnails scattered through albums here. `force: true` removes the user and its assets
    // together, which is what `leave_album` already does for a mirror's stubs.
    //
    // Deleting them takes their album memberships with them, which is what closes the RE-LINK hole:
    // nothing is left behind for a future directory sync to misread as a fresh invitation.
    let doomed: Vec<String> = state
        .collections()
        .contributors
        .iter()
        .filter(|(slug, c)| {
            slug.starts_with(crate::config::bot_prefix::PERSON)
                && c.home_peer.as_deref().or(c.via_peer.as_deref()) == Some(pub_key)
        })
        .map(|(slug, _)| slug.clone())
        .collect();
    for slug in doomed {
        let user_id = state
            .collections()
            .contributors
            .get(&slug)
            .and_then(|c| c.user_id.clone());
        if let Some(user_id) = user_id {
            let body = serde_json::json!({ "force": true });
            if let Err(e) = client
                .json(
                    reqwest::Method::DELETE,
                    &format!("/admin/users/{user_id}"),
                    &crate::immich::client::Auth::Admin,
                    Some(&body),
                )
                .await
            {
                // LEFT BEHIND, and the state entry with it: keeping the record means a re-link
                // reuses this account rather than minting a twin beside it.
                crate::log!("unlink: could not delete {slug}: {e} — leaving it in place");
                continue;
            }
            markers_removed += 1;
        }
        state.collections().contributors.remove(&slug);
    }

    state.collections().peers.retain(|p| p.pub_key != pub_key);
    state.save().map_err(|e| e.to_string())?;
    crate::log!(
        "unlinked \"{household}\" — {mirrors_removed} mirror(s) removed, {shares_revoked} share(s) revoked, {markers_removed} account(s) removed with their proxied photos"
    );
    Ok(UnlinkResult { household, mirrors_removed, shares_revoked, markers_removed })
}

/// What the panel shows: one row per linked server, with what the link is currently carrying.
pub fn linked_peers(state: &State) -> Vec<Value> {
    let collections = state.collections();
    collections
        .peers
        .iter()
        .map(|p| {
            let live = |role: Role| {
                collections
                    .mappings
                    .iter()
                    .filter(|m| m.peer == p.pub_key && m.role == role && !m.dead)
                    .count()
            };
            // A person belongs to a server only when we KNOW where they live: `homePeer` is set by
            // a linked server's directory, and a relayed photo names a person but not their server.
            let people = collections
                .contributors
                .iter()
                .filter(|(slug, c)| {
                    slug.starts_with(bot_prefix::PERSON)
                        && c.home_peer.as_deref().or(c.via_peer.as_deref()) == Some(p.pub_key.as_str())
                })
                .count();
            json!({
                "pub": p.pub_key,
                "name": p.name,
                "version": p.version,
                "sharedToThem": live(Role::Owner),
                "sharedToUs": live(Role::Member),
                "people": people,
            })
        })
        .collect()
}

/// Albums this server is sharing or receiving, for the panel.
pub fn shared_albums(state: &State) -> Vec<Value> {
    let collections = state.collections();
    collections
        .mappings
        .iter()
        .filter(|m| !m.dead)
        .map(|m| {
            json!({
                "name": m.album_name,
                "role": m.role.as_str(),
                "via": m.via,
                "peer": collections
                    .peers
                    .iter()
                    .find(|p| p.pub_key == m.peer)
                    .map(|p| p.name.clone())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// Our own household identity, for the panel header.
pub fn local_household() -> Value {
    json!({ "name": cfg().name })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::immich::access::Creds;
    use crate::store::{Contributor, Mapping, Peer};
    use std::sync::Arc;

    fn state_with(peers: Vec<Peer>, mappings: Vec<Mapping>, contributors: Vec<(String, Contributor)>) -> Arc<State> {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let mut c = store.state.lock().unwrap();
            c.peers = peers;
            c.mappings = mappings;
            c.contributors = contributors.into_iter().collect();
        }
        Arc::new(State::for_test(store))
    }

    fn peer(pub_key: &str, name: &str) -> Peer {
        Peer {
            pub_key: pub_key.into(),
            name: name.into(),
            version: Some("1.1.1".into()),
            protocol: Some(2),
            features: Some(vec!["sync-status".into()]),
            via: "pair".into(),
            first_seen_at: "2026-01-01T00:00:00.000Z".into(),
            relay_hint: None,
            last_addrs: None,
        }
    }

    fn mapping(peer_key: &str, role: Role, dead: bool) -> Mapping {
        Mapping {
            id: format!("m-{peer_key}-{}", role.as_str()),
            role,
            album_id: "a1".into(),
            album_name: "Holidays".into(),
            peer: peer_key.into(),
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

    #[test]
    fn a_linked_peer_row_counts_only_live_owner_mappings_as_shared_out() {
        let s = state_with(
            vec![peer("peer-b", "Household B")],
            // One live owner share, one live member mirror, and one DEAD owner share that must not count.
            vec![
                mapping("peer-b", Role::Owner, false),
                mapping("peer-b", Role::Member, false),
                {
                    let mut m = mapping("peer-b", Role::Owner, true);
                    m.id = "dead".into();
                    m
                },
            ],
            vec![],
        );
        let rows = linked_peers(&s);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "Household B");
        assert_eq!(rows[0]["sharedToThem"], 1, "the dead mapping is not a live share");
        assert_eq!(rows[0]["sharedToUs"], 1);
    }

    #[test]
    fn home_peer_wins_over_the_peer_we_met_them_through() {
        // A relayed photo names a person but not their server, so `viaPeer` records where we met
        // them. `homePeer` is set only by that person's own server's directory. The panel must
        // attribute them to their HOME, or a photo relayed through B would file a D-resident
        // against B.
        let s = state_with(
            vec![peer("peer-b", "B"), peer("peer-c", "C")],
            vec![],
            vec![
                ("person-1".into(), contributor_with(Some("peer-c"), Some("peer-b"))),
                // Known only through a relay: no proven home, so the peer we met them through stands.
                ("person-2".into(), contributor_with(None, Some("peer-b"))),
                // Not a per-person account, so it is never counted as a person.
                ("house-bot".into(), contributor_with(Some("peer-b"), Some("peer-b"))),
            ],
        );
        let rows = linked_peers(&s);
        let by_name: std::collections::HashMap<_, _> =
            rows.iter().map(|r| (r["name"].as_str().unwrap().to_string(), r["people"].as_u64().unwrap())).collect();
        assert_eq!(by_name["C"], 1, "person-1 lives on C even though the photo came via B");
        assert_eq!(by_name["B"], 1, "person-2 has no proven home, so viaPeer stands");
    }

    fn contributor_with(home: Option<&str>, via: Option<&str>) -> Contributor {
        Contributor {
            user_id: Some("u1".into()),
            api_key: Some("key".into()),
            password: None,
            avatar_done: true,
            via_peer: via.map(|s| s.to_string()),
            peer_user_id: Some("u1".into()),
            home_peer: home.map(|s| s.to_string()),
        }
    }

    #[test]
    fn shared_albums_omits_dead_mappings_and_names_the_peer() {
        let s = state_with(
            vec![peer("peer-b", "Household B")],
            vec![mapping("peer-b", Role::Member, false), {
                let mut m = mapping("peer-b", Role::Owner, true);
                m.id = "dead".into();
                m
            }],
            vec![],
        );
        let albums = shared_albums(&s);
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0]["name"], "Holidays");
        assert_eq!(albums[0]["role"], "member");
        assert_eq!(albums[0]["peer"], "Household B");
        let _ = Creds { headers: Default::default() };
    }

    #[test]
    fn a_peer_with_no_name_still_yields_a_row() {
        let s = state_with(vec![peer("peer-z", "")], vec![], vec![]);
        assert_eq!(linked_peers(&s)[0]["name"], "");
        assert_eq!(linked_peers(&s)[0]["people"], 0);
    }
}
