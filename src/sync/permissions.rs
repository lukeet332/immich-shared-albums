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
        let still_recorded = state
            .collections()
            .mappings
            .iter()
            .find(|m| m.id == mapping_id)
            .map(|m| role.as_str() == crate::sync::mirror::member_role(&m.permissions))
            .unwrap_or(false);
        if still_recorded {
            continue;
        }
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

/// Tell the peer its album's permission changed. A FACT rather than a command: the receiver records
/// it and answers what it did, so a retry is a no-op rather than a second write.
pub async fn notify_peer(state: &State, drift: &Drift) -> bool {
    let Some(peer) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == drift.peer)
        .cloned()
    else {
        return false;
    };
    let Some(transport) = transport() else {
        return false;
    };
    let body =
        serde_json::json!({ "albumId": drift.album_id, "permissions": permissions_for(&drift.role) })
            .to_string();
    let header = RequestHeader {
        path: PERMISSIONS_PATH.to_string(),
        ..Default::default()
    };
    match transport
        .round_trip(&peer, &header, Some(body.as_bytes()))
        .await
    {
        Ok((head, _)) => head.status < 400,
        Err(e) => {
            crate::log!("permission notify to \"{}\" failed: {e}", peer.name);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Collections;

    fn album_with(member: &str, role: &str) -> Value {
        serde_json::json!({
            "albumUsers": [{ "role": role, "user": { "id": member } }]
        })
    }

    #[test]
    fn a_role_is_read_from_the_member_it_belongs_to() {
        let album = serde_json::json!({
            "albumUsers": [
                { "role": "owner", "user": { "id": "owner-1" } },
                { "role": "viewer", "user": { "id": "person-1" } }
            ]
        });
        assert_eq!(
            member_role_in(&album, "person-1").as_deref(),
            Some("viewer")
        );
        assert_eq!(member_role_in(&album, "owner-1").as_deref(), Some("owner"));
    }

    #[test]
    fn an_unreadable_member_list_is_not_evidence_about_anyone() {
        // The direction that matters: writing over a known permission because a read came back empty
        // would hand a view-only share away on a transient error.
        assert_eq!(member_role_in(&serde_json::json!({}), "person-1"), None);
        assert_eq!(
            member_role_in(&serde_json::json!({ "albumUsers": null }), "p"),
            None
        );
        assert_eq!(
            member_role_in(&album_with("someone-else", "editor"), "person-1"),
            None
        );
    }

    #[test]
    fn an_immich_role_survives_being_stored_as_a_share_permission() {
        // The round trip is the invariant, not the strings: an owner watching their album learns
        // nothing if a role recorded as `contribute` reads back as anything but `editor`.
        for role in ["editor", "viewer"] {
            assert_eq!(
                crate::sync::mirror::member_role(permissions_for(role)),
                role,
                "{role} must survive the trip through a share permission"
            );
        }
    }

    fn collections_with(people: Vec<(&str, &str, &str)>) -> Collections {
        // (slug, local user id, the person's id on their own server); `viaPeer` pairs each with its
        // own slug so a household's "person-a" and another household's never collide.
        Collections {
            contributors: people
                .into_iter()
                .map(|(slug, user_id, peer_user_id)| {
                    (
                        slug.to_string(),
                        crate::store::Contributor {
                            user_id: user_id.to_string(),
                            api_key: "key".into(),
                            password: None,
                            avatar_done: true,
                            via_peer: Some(slug.to_string()),
                            peer_user_id: Some(peer_user_id.to_string()),
                            home_peer: None,
                        },
                    )
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn a_person_is_looked_up_by_their_id_on_their_own_server_plus_the_peer() {
        // Two households both have a "user id"; only the pair identifies which person is meant.
        let collections = collections_with(vec![
            ("peer-a", "local-a", "person-a"),
            ("peer-b", "local-b", "person-a"),
        ]);
        let ids = vec!["person-a".to_string()];
        assert_eq!(
            local_person_id(&collections, "peer-a", Some(&ids)).as_deref(),
            Some("local-a"),
            "the same id from the other peer must not resolve"
        );
        assert_eq!(local_person_id(&collections, "peer-z", Some(&ids)), None);
    }
}
