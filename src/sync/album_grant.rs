/** sync/album_grant.rs — who may touch a reunified album, and who must not. See ARCHITECTURE.md. */
use crate::immich::access::Creds;
use crate::immich::client::{Auth, Client};
use crate::immich::contributors::ensure_contributor;
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::Peer;
use serde_json::Value;
use std::collections::HashSet;

/// How long a reunion waits for the peer's manifest before granting what it can.
pub const GRANT_MANIFEST_DEADLINE_MS: u64 = 10_000;

/// One person on the peer's side who has photos in the album being reunited.
#[derive(Clone, Debug, PartialEq)]
pub struct PeerContributor {
    pub origin_user_id: String,
    pub display_name: String,
}

/// The distinct people behind a peer's manifest for one album.
///
/// Distinct by the person's id on THEIR server: a manifest carries one ref per photo, so the same
/// contributor appears many times and must be granted ONE membership, not one per photo.
///
/// Best effort — an unreachable peer yields nobody, and the reunion proceeds without granting. A
/// contributor the peer only starts offering later cannot be covered at all: nothing can grant a
/// membership without the album's owner present, which is why the panel's reunion list is the
/// surface that can re-run this with an owner in the loop.
pub fn distinct_contributors(manifest: &[Value], fallback_name: &str) -> Vec<PeerContributor> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for reference in manifest {
        let Some(origin_user_id) = reference
            .pointer("/contributor/originUserId")
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if origin_user_id.is_empty() || !seen.insert(origin_user_id.to_string()) {
            continue;
        }
        let name = reference
            .pointer("/contributor/displayName")
            .and_then(|v| v.as_str())
            .filter(|n| !n.is_empty())
            .unwrap_or(fallback_name);
        out.push(PeerContributor {
            origin_user_id: origin_user_id.to_string(),
            display_name: name.to_string(),
        });
    }
    out
}

/// Ask the peer who contributed to the album it is offering.
pub async fn peer_contributors(peer: &Peer, remote_target: Option<&str>) -> Vec<PeerContributor> {
    let Some(target) = remote_target.filter(|t| !t.is_empty()) else {
        return Vec::new();
    };
    let Some(transport) = transport() else {
        return Vec::new();
    };
    let header = RequestHeader {
        path: format!("/albums/{target}/manifest"),
        ..Default::default()
    };
    let Ok(Ok((head, body))) = tokio::time::timeout(
        std::time::Duration::from_millis(GRANT_MANIFEST_DEADLINE_MS),
        transport.round_trip(peer, &header, None),
    )
    .await
    else {
        return Vec::new();
    };
    if head.status >= 400 {
        return Vec::new();
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let manifest = parsed
        .get("manifest")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();
    distinct_contributors(&manifest, &peer.name)
}

/// Add the accounts that will OWN a reunified album's mirrored stubs, as album EDITORS.
///
/// Only an album's owner can add a member, and the owner's credentials exist in exactly one place:
/// the request in which they reunited. So every contributor the peer offers is granted HERE, at
/// adoption, rather than lazily during a reconcile that has no owner credential to offer — which is
/// what a `403 albumUser.create` on every cycle looked like from the outside.
///
/// EDITOR, where the house bot is a VIEWER: these accounts upload the stubs they own, and Immich
/// refuses that with `albumAsset.create` for anything less.
pub async fn grant_album_writers(
    state: &State,
    client: &Client,
    album_id: &str,
    owner_creds: &Creds,
    peer: &Peer,
    contributors: &[PeerContributor],
) -> usize {
    let mut granted = 0usize;
    for contributor in contributors {
        let outcome = ensure_contributor(
            state,
            client,
            &contributor.display_name,
            album_id,
            &Auth::Creds(owner_creds),
            Some(&contributor.origin_user_id),
            Some(&peer.pub_key),
            true,
            false,
        )
        .await;
        match outcome {
            Ok(_) => granted += 1,
            Err(e) => crate::log!(
                "could not grant \"{}\" access to album {}: {e}",
                contributor.display_name,
                crate::config::short_id(album_id)
            ),
        }
    }
    granted
}

/// Make sure the people an INVITATION names are members of the reunified album.
///
/// Adding is the easy half. The membership is what makes the album appear for them at all, and a
/// reunion that omits it leaves the other side looking at a share nobody can see.
pub async fn grant_invited_humans(
    client: &Client,
    album_id: &str,
    owner_creds: &Creds,
    user_ids: &[String],
    role: &str,
) -> usize {
    if user_ids.is_empty() {
        return 0;
    }
    let album = client
        .get_album(album_id, &Auth::Creds(owner_creds))
        .await
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let already: HashSet<String> = album
        .get("albumUsers")
        .and_then(|u| u.as_array())
        .map(|users| {
            users
                .iter()
                .filter_map(|au| {
                    au.pointer("/user/id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let wanted: Vec<&String> = user_ids
        .iter()
        .filter(|id| !already.contains(*id))
        .collect();
    if wanted.is_empty() {
        return 0;
    }
    let members: Vec<Value> = wanted
        .iter()
        .map(|id| serde_json::json!({ "userId": id, "role": role }))
        .collect();
    let count = members.len();
    if client
        .json(
            reqwest::Method::PUT,
            &format!("/albums/{album_id}/users"),
            &Auth::Creds(owner_creds),
            Some(&serde_json::json!({ "albumUsers": members })),
        )
        .await
        .is_err()
    {
        return 0;
    }
    count
}

/// Take our own stand-ins off an album we have stopped syncing.
///
/// Immich would otherwise keep showing these people on an album nobody is mirroring any more — and
/// the divergence is SILENT, because re-adding an existing member is a no-op that produces no new
/// signal, so the share could never be put back by hand.
///
/// Only the accounts in the `added` ledger, i.e. the ones WE created for attribution. A human's
/// membership is their decision and is never touched here.
pub async fn strip_album_bots(
    state: &State,
    client: &Client,
    album_id: &str,
    owner_creds: &Creds,
) -> (usize, Vec<String>) {
    let album = client
        .get_album(album_id, &Auth::Creds(owner_creds))
        .await
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let ours: Vec<(String, String)> = album
        .get("albumUsers")
        .and_then(|u| u.as_array())
        .map(|users| {
            users
                .iter()
                .filter(|au| au.get("role").and_then(|r| r.as_str()) != Some("owner"))
                .filter_map(|au| {
                    let id = au.pointer("/user/id").and_then(|v| v.as_str())?;
                    let email = au.pointer("/user/email").and_then(|v| v.as_str());
                    if !crate::config::is_utility_email(email) {
                        return None;
                    }
                    Some((id.to_string(), email.unwrap_or_default().to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut removed = 0usize;
    let mut failed = Vec::new();
    for (user_id, email) in ours {
        // RETRIED ONCE, because this is the LAST moment the credential that can do it exists: the
        // owner's key is deliberately never stored, so nothing can retry this later. Every account
        // that LOOKS like ours comes off, whether or not the ledger remembers adding it — a
        // membership missed here is one of our accounts still reading a private album.
        let mut removed_this_one = false;
        for attempt in 1..=2 {
            match client
                .json(
                    reqwest::Method::DELETE,
                    &format!("/albums/{album_id}/user/{user_id}"),
                    &Auth::Creds(owner_creds),
                    None,
                )
                .await
            {
                Ok(_) => {
                    removed_this_one = true;
                    break;
                }
                Err(e) => {
                    crate::log!(
                        "  could not take our account off \"{}\" (attempt {attempt}): {e}",
                        crate::config::short_id(album_id)
                    );
                }
            }
        }
        if removed_this_one {
            let _ = state.store.added_forget(album_id, &user_id);
            removed += 1;
            crate::log!("  removed our own attribution membership from \"{email}\"");
        } else {
            failed.push(user_id);
        }
    }
    (removed, failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_membership_per_person_however_many_photos_they_contributed() {
        let manifest = vec![
            json!({ "contributor": { "originUserId": "u1", "displayName": "Nan" } }),
            json!({ "contributor": { "originUserId": "u1", "displayName": "Nan" } }),
            json!({ "contributor": { "originUserId": "u2", "displayName": "Joe" } }),
        ];
        let people = distinct_contributors(&manifest, "the peer");
        assert_eq!(people.len(), 2, "a manifest carries one ref per PHOTO");
        assert_eq!(people[0].origin_user_id, "u1");
    }

    #[test]
    fn a_ref_with_no_contributor_id_is_skipped_rather_than_granted_to_nobody() {
        let manifest = vec![
            json!({ "contributor": { "displayName": "Nan" } }),
            json!({ "contributor": { "originUserId": "" } }),
        ];
        assert!(distinct_contributors(&manifest, "the peer").is_empty());
    }

    #[test]
    fn a_contributor_with_no_name_is_called_after_their_server() {
        // Attribution needs a name, and a membership needs a name; the peer's own name is the
        // honest fallback — better than a blank account in someone's People list.
        let manifest = vec![json!({ "contributor": { "originUserId": "u1" } })];
        assert_eq!(distinct_contributors(&manifest, "The Smiths").len(), 1);
        assert_eq!(
            distinct_contributors(&manifest, "The Smiths")[0].display_name,
            "The Smiths"
        );
    }
}
