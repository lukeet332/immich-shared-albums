/** sync/permissions.rs — keeping one album's permission true on the server that can change it. See docs/wire-protocol.md. */
use crate::immich::client::{Auth, Client};
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::state::State;
use serde_json::Value;

/// Where an owner reports a permission change. A path of its own rather than an album route: the
/// owner has no remote mapping id for an album it owns, so the album travels in the body, named by
/// the id the RECEIVER already holds as `remoteAlbumId`.
pub const PERMISSIONS_PATH: &str = "/albums/permissions";

/// What this addon calls an Immich member role. The inverse of `mirror::member_role`.
///
/// Two vocabularies meet here and are not the same strings: a share says `contribute`/`view`, and an
/// Immich membership says `editor`/`viewer`. Everything crossing the wire from this module is
/// IMMICH's, because that is what a membership actually carries.
pub fn permissions_for(role: &str) -> &'static str {
    if role == "editor" {
        "contribute"
    } else {
        "view"
    }
}

/// The role the remote person's account holds in an album, read from Immich.
///
/// `None` is the point: an unreadable member list, or one naming nobody, is not evidence about
/// anybody's permission and must never overwrite a permission already recorded.
pub fn member_role_in(album: &Value, user_id: &str) -> Option<String> {
    album
        .get("albumUsers")
        .and_then(|members| members.as_array())?
        .iter()
        .find(|entry| entry.pointer("/user/id").and_then(|v| v.as_str()) == Some(user_id))
        .and_then(|entry| entry.get("role"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// An album whose permission in Immich no longer matches what this side recorded.
#[derive(Clone, Debug, PartialEq)]
pub struct Drift {
    pub mapping_id: String,
    /// The peer's public key, so the notification is addressed to whoever owns the other half.
    pub peer: String,
    /// This side's album id — what the peer knows this album as.
    pub album_id: String,
    pub album_name: String,
    /// The role now in Immich, as Immich spells it.
    pub role: String,
}

/// The albums a person's own change has moved away from what this side recorded.
///
/// Only an OWNER mapping can drift: a member mapping's permission was set by the peer that owns the
/// album, and applying it is the very reconcile that would otherwise read it back. The owner is the
/// only side whose credential can change a membership, so the owner is the only side that watches.
pub async fn owner_side_drift(state: &State, client: &Client) -> Vec<Drift> {
    // COLLECTED FIRST, then read. `collections()` hands back a non-reentrant mutex guard, so holding
    // one across an Immich call parks every other loop behind a network round trip — and the
    // alternative, dropping and re-taking it per album, would let the mappings move under the walk.
    let candidates: Vec<(String, String, String, String, String)> = {
        let collections = state.collections();
        collections
            .mappings
            .iter()
            .filter(|m| !m.dead && m.role == crate::store::Role::Owner)
            .filter_map(|m| {
                let person =
                    local_person_id(&collections, &m.peer, m.for_peer_user_ids.as_deref())?;
                Some((
                    m.id.clone(),
                    m.peer.clone(),
                    m.album_id.clone(),
                    m.album_name.clone(),
                    person,
                ))
            })
            .collect()
    };

    let mut drifted = Vec::new();
    for (mapping_id, peer, album_id, album_name, person) in candidates {
        let Some(album) = client
            .get_album(&album_id, &Auth::Admin)
            .await
            .ok()
            .flatten()
        else {
            continue;
        };
        let Some(role) = member_role_in(&album, &person) else {
            continue;
        };
        // Every owner mapping is returned, not only ones whose LOCAL record disagrees. The
        // reconcile broadcasts every cycle so a notify that was dropped (transport not up yet) is
        // re-sent; filtering to "newly changed" here is exactly what made a single dropped notify
        // permanent. The receiver applies idempotently, so a redundant send costs a round trip and
        // changes nothing.
        drifted.push(Drift {
            mapping_id,
            peer,
            album_id,
            album_name,
            role,
        });
    }
    drifted
}

/// The local Immich id of the remote person an album was shared with.
///
/// Keyed on the person's id on THEIR server plus the peer, because that pair is what a contributor
/// row is keyed on — and it is the only join that cannot mistake one household's person for
/// another's, whose ids are of course both "a user id".
fn local_person_id(
    collections: &crate::store::Collections,
    peer: &str,
    for_peer_user_ids: Option<&[String]>,
) -> Option<String> {
    let person = for_peer_user_ids?.first()?;
    collections
        .contributors
        .values()
        .find(|c| c.via_peer.as_deref() == Some(peer) && c.peer_user_id.as_deref() == Some(person))
        .map(|c| c.user_id.clone())
        .filter(|id| !id.is_empty())
}

/// Record what Immich says, so the next pass starts from the truth rather than from the permission
/// the album was first shared with. `false` means there was nothing to change.
pub fn record(state: &State, drift: &Drift) -> bool {
    let permissions = permissions_for(&drift.role);
    let changed = state
        .collections()
        .mappings
        .iter_mut()
        .find(|m| m.id == drift.mapping_id)
        .is_some_and(|live| {
            if live.permissions == permissions {
                return false;
            }
            live.permissions = permissions.to_string();
            true
        });
    if changed {
        let _ = state.save();
    }
    changed
}

/// Record what the OWNER says about an album of ours. The owner is the only side that can change the
/// membership, so this records rather than argues: a peer cannot escalate by claiming a permission.
///
/// Addressed by the owner's album id because that is the one name both sides hold — an owner's own
/// mapping has no remote mapping id to address the peer by.
pub fn apply_owner_report(
    state: &State,
    reporting_peer: &str,
    owner_album_id: &str,
    permissions: &str,
) -> bool {
    let owned = match permissions {
        "contribute" | "view" => permissions,
        // An unknown permission is not a permission to record, and guessing one would write a value
        // no reconcile could ever match again.
        _ => return false,
    };
    let changed = state
        .collections()
        .mappings
        .iter_mut()
        .find(|m| {
            m.role == crate::store::Role::Member
                && m.peer == reporting_peer
                && m.remote_album_id.as_deref() == Some(owner_album_id)
        })
        .is_some_and(|live| {
            if live.permissions == owned {
                return false;
            }
            live.permissions = owned.to_string();
            true
        });
    if changed {
        let _ = state.save();
    }
    changed
}

/// The peers this side shared `album_id` ONWARD to — the peers of its OWNER mappings for that
/// album. This is the sender's view of the outward edge: an owner mapping says "this household holds
/// this album", and that household must be told when the permission moves.
///
/// It is deliberately NOT the reverse query (peers whose `remoteAlbumId` is this album): that is the
/// RECEIVER's view and is empty on the sender, because no one on this side has a remote id equal to
/// an album we originate. Using it here sent nothing at all.
pub fn downstream_peers(state: &State, album_id: &str) -> Vec<crate::store::Peer> {
    let collections = state.collections();
    let mut pubs: Vec<&str> = collections
        .mappings
        .iter()
        .filter(|m| !m.dead && m.role == crate::store::Role::Owner && m.album_id == album_id)
        .map(|m| m.peer.as_str())
        .collect();
    pubs.sort_unstable();
    pubs.dedup();
    collections
        .peers
        .iter()
        .filter(|p| pubs.contains(&p.pub_key.as_str()))
        .cloned()
        .collect()
}

/// Tell one peer that `album_id` is now worth `permissions`. A FACT rather than a command: the
/// receiver records it and answers what it did, so a retry is a no-op rather than a second write.
pub async fn tell_peer(peer: &crate::store::Peer, album_id: &str, role: &str) -> bool {
    let Some(transport) = transport() else {
        return false;
    };
    let body = serde_json::json!({ "albumId": album_id, "permissions": permissions_for(role) })
        .to_string();
    let header = RequestHeader {
        path: PERMISSIONS_PATH.to_string(),
        ..Default::default()
    };
    match transport
        .round_trip(peer, &header, Some(body.as_bytes()))
        .await
    {
        Ok((head, _)) => head.status < 400,
        Err(e) => {
            crate::log!("permission notify to \"{}\" failed: {e}", peer.name);
            false
        }
    }
}

/// Broadcast a permission change to every household that holds this album, so the change travels
/// the whole chain. Best effort per peer: one unreachable household does not stop the rest, and the
/// next reconcile re-nudges whoever did not take it.
pub async fn broadcast(state: &State, album_id: &str, role: &str) {
    let peers = downstream_peers(state, album_id);
    crate::log!(
        "permission broadcast: {} peer(s) for {album_id}",
        peers.len()
    );
    for peer in peers {
        tell_peer(&peer, album_id, role).await;
    }
}

/// The owner's own reconcile: record what Immich says, then broadcast it outward. Run by the watcher
/// beside `reconcile_once` — those albums are OWNER mappings and that walk is members only.
pub async fn reconcile_owner_side(state: &State, client: &Client) {
    let all = owner_side_drift(state, client).await;
    crate::log!("permission reconcile: {} owner album(s)", all.len());
    for drift in all {
        // RECORD BEFORE the broadcast. A broadcast that fails leaves this side true and the peer
        // stale, which the next pass repairs; the reverse leaves a peer believing a change this side
        // no longer has, and nothing would ever contradict it.
        if record(state, &drift) {
            crate::log!(
                "\"{}\" is now \"{}\" — permission updated",
                drift.album_name,
                drift.role
            );
        }
        broadcast(state, &drift.album_id, &drift.role).await;
    }
}

/// This side's LOCAL album id for a peer's album, for the chain hop. `remoteAlbumId` is the id the
/// ORIGIN knew it by; the households downstream of us know it by OUR id, so the outbound hop carries
/// this, not the id that arrived.
pub fn local_mirror_of(
    state: &State,
    reporting_peer: &str,
    owner_album_id: &str,
) -> Option<String> {
    state
        .collections()
        .mappings
        .iter()
        .find(|m| {
            !m.dead
                && m.peer == reporting_peer
                && m.remote_album_id.as_deref() == Some(owner_album_id)
        })
        .map(|m| m.album_id.clone())
}

/// The Immich role a stored share permission speaks for, so a broadcast can carry either.
pub fn role_of(permissions: &str) -> &'static str {
    crate::sync::mirror::member_role(permissions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Mapping, Role};

    fn member(role: &str, id: &str) -> Value {
        serde_json::json!({ "role": role, "user": { "id": id } })
    }

    fn peer(pub_key: &str) -> crate::store::Peer {
        crate::store::Peer {
            pub_key: pub_key.into(),
            name: format!("household {pub_key}"),
            version: None,
            protocol: None,
            features: None,
            via: "link".into(),
            first_seen_at: "now".into(),
            relay_hint: None,
            last_addrs: None,
            advertised_host: None,
        }
    }

    fn member_mapping(peer_key: &str, album: &str, remote: &str) -> Mapping {
        Mapping {
            id: format!("m-{album}"),
            role: Role::Member,
            album_id: album.into(),
            album_name: album.into(),
            peer: peer_key.into(),
            remote_album_id: Some(remote.into()),
            remote_mapping_id: None,
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
    fn a_role_is_read_from_the_member_it_belongs_to() {
        let album =
            serde_json::json!({ "albumUsers": [member("owner", "o1"), member("viewer", "p1")] });
        assert_eq!(member_role_in(&album, "p1").as_deref(), Some("viewer"));
        assert_eq!(member_role_in(&album, "o1").as_deref(), Some("owner"));
    }

    #[test]
    fn an_unreadable_member_list_is_not_evidence_about_anyone() {
        // Writing a known permission over because a read came back empty would hand a view-only
        // share away on a transient error.
        assert_eq!(member_role_in(&serde_json::json!({}), "p1"), None);
        assert_eq!(
            member_role_in(&serde_json::json!({ "albumUsers": null }), "p"),
            None
        );
        assert_eq!(
            member_role_in(
                &serde_json::json!({ "albumUsers": [member("editor", "other")] }),
                "p1"
            ),
            None
        );
    }

    #[test]
    fn an_immich_role_survives_being_stored_as_a_share_permission() {
        for role in ["editor", "viewer"] {
            assert_eq!(
                crate::sync::mirror::member_role(permissions_for(role)),
                role,
                "{role} must survive the trip through a share permission"
            );
        }
    }

    fn state_with(mappings: Vec<Mapping>, peers: Vec<crate::store::Peer>) -> State {
        let store = crate::store::Store::open_in_memory().unwrap();
        {
            let mut c = store.state.lock().unwrap();
            c.peers = peers;
            c.mappings = mappings;
        }
        State::for_test(store)
    }

    #[test]
    fn downstream_are_the_peers_we_shared_the_album_onward_to() {
        // The SENDER's view: our OWNER mappings name the households holding the album. A member
        // mapping (the album came from elsewhere) is not something we can push a permission about.
        let mut onward = member_mapping("p1", "origin-album", "upstream");
        onward.role = Role::Owner;
        onward.remote_album_id = None;
        let state = state_with(
            vec![onward, member_mapping("p3", "other", "upstream")],
            vec![peer("p1"), peer("p2"), peer("p3")],
        );
        let held = downstream_peers(&state, "origin-album");
        assert_eq!(
            held.iter().map(|p| p.pub_key.as_str()).collect::<Vec<_>>(),
            vec!["p1"],
            "only the household our owner mapping points at"
        );
    }

    #[test]
    fn the_chain_hop_carries_the_local_album_id_not_the_arriving_one() {
        // B reports "origin-album"; C's downstream peers know C's mirror as "mirror-1", so the
        // outbound hop must carry the id C knows it by.
        let state = state_with(
            vec![member_mapping("p1", "mirror-1", "origin-album")],
            vec![peer("p1")],
        );
        assert_eq!(
            local_mirror_of(&state, "p1", "origin-album").as_deref(),
            Some("mirror-1"),
            "the hop carries the local id"
        );
        assert_eq!(local_mirror_of(&state, "p1", "not-ours"), None);
    }

    #[test]
    fn only_the_reporting_peer_can_move_a_mapping_of_its_album() {
        // A peer cannot escalate by claiming a permission on an album it does not own: the mapping
        // it would be writing is the one THAT peer shares with us, so p2 must be refused p1's album.
        let state = state_with(
            vec![member_mapping("p1", "mirror-1", "origin-album")],
            vec![peer("p1"), peer("p2")],
        );
        assert!(
            !apply_owner_report(&state, "p2", "origin-album", "view"),
            "p2 does not hold this album — its claim must be refused"
        );
        let still = state.collections().mappings[0].permissions.clone();
        assert_eq!(still, "contribute", "refused, so nothing changed");

        // The peer that DOES hold it moves it, and the change sticks.
        assert!(
            apply_owner_report(&state, "p1", "origin-album", "view"),
            "p1 holds this album and is its owner"
        );
        assert_eq!(state.collections().mappings[0].permissions, "view");
    }
}
