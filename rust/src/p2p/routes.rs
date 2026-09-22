/** p2p/routes.rs — the peer route table: the only place peer operations exist. See PORT.md. */
use crate::config::SIDECAR_VERSION;
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::{PeerAnswer, PeerHandler};
use crate::protocol::PROTOCOL_VERSION;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// What this build advertises. A feature list is additive: a peer that does not know a name simply
/// does not use it, so adding one is never a breaking change.
pub const PROTOCOL_FEATURES: [&str; 1] = ["sync-status"];

/// The peer route table. `/hello` is first because it is the handshake every other route assumes.
///
/// A handler that does not know a path answers 404 rather than dropping the stream: a dropped
/// stream is indistinguishable from a network fault, and the dialler would retry against a server
/// that simply does not serve that route.
pub fn handler() -> PeerHandler {
    Arc::new(|caller: String, header: RequestHeader, body: Vec<u8>| {
        Box::pin(async move { route(&caller, &header, &body).await })
    })
}

async fn route(caller: &str, header: &RequestHeader, body: &[u8]) -> PeerAnswer {
    match header.path.as_str() {
        // Another server redeeming a code we issued. The connection already proved the CALLER holds
        // the key being enrolled; the secret proves an admin here invited them.
        // The sync reads. Each one resolves the mapping from the CALLER's key, so a valid
        // connection can never address someone else's album, and each answers 410 for a withdrawn
        // share so a receiver tears its side down instead of retrying forever.
        // What a peer is pushing. Before the reads, because a push is the route that does work.
        p if p.ends_with("/refs") => {
            let id = album_mapping_id(p, "/refs");
            let (status, value) = crate::p2p::protocol::handle_refs(caller, &id, body).await;
            json_answer(status, value)
        }
        // The conversation. `/activity` is a peer pushing what was SAID; `/comments` is a member
        // pulling the canonical list. Unlike the photo routes these carry no permission gate —
        // view-only governs photos, not talk.
        p if p.ends_with("/activity") => {
            let id = album_mapping_id(p, "/activity");
            let state = crate::state::state();
            let (status, value) =
                crate::sync::comments::handle_activity(state, crate::immich::client::shared(), caller, &id, body)
                    .await;
            json_answer(status, value)
        }
        p if p.ends_with("/comments") => {
            let id = album_mapping_id(p, "/comments");
            let state = crate::state::state();
            let (status, value) =
                crate::sync::comments::handle_comments(state, crate::immich::client::shared(), caller, &id)
                    .await;
            json_answer(status, value)
        }
        // What the caller has been INVITED to, by people here. Members poll this; the origin never
        // pushes an invitation, because a member with no inbound reachability still syncs perfectly
        // well by pulling, and a push-based invite would fail for exactly those households.
        p if p.ends_with("/invitations") => {
            let state = crate::state::state();
            let invitations = crate::sync::invites::invitations_for(state, caller);
            json_answer(200, serde_json::json!({ "invitations": invitations }))
        }
        // "Look at your invitations again now." Says nothing about what changed, and losing it costs
        // the latency of the next sweep.
        p if p.ends_with("/invitations/nudge") => {
            let state = crate::state::state();
            let (status, value) = crate::sync::invites::handle_invitations_nudge(state, caller);
            json_answer(status, value)
        }
        // The people this household offers the caller, so the caller can put them in its own
        // Immich picker as invite targets. NAMES ONLY, and empty when ISA_PUBLISH_USER_DIRECTORY is
        // off — sharing is per person, so with no directory there is nobody to name.
        "/directory" => {
            let users = crate::sync::directory::local_directory(crate::immich::client::shared()).await;
            json_answer(200, serde_json::json!({ "users": users }))
        }
        // What this household OFFERS the caller, for matching. Pull-only, and it answers for the
        // CALLER's own key, so a peer can only ever read the index addressed to it.
        "/albums" => {
            let state = crate::state::state();
            let albums = crate::sync::album_index::published_albums_for(state, caller);
            json_answer(200, serde_json::json!({ "albums": albums }))
        }
        // A peer reporting that its share is now part of a reunion. A FACT, not a command: it
        // records what happened and asks for nothing back, and it is what clears the pairing from
        // this household's "possible reunions" list.
        p if p.ends_with("/reunified") => {
            let id = album_mapping_id(p, "/reunified");
            let state = crate::state::state();
            let (status, value) = crate::p2p::protocol::handle_reunified(state, caller, &id);
            json_answer(status, value)
        }
        p if p.ends_with("/version") => {
            let id = album_mapping_id(p, "/version");
            let (status, value) = crate::p2p::protocol::handle_version(caller, &id).await;
            json_answer(status, value)
        }
        p if p.ends_with("/manifest") => {
            let id = album_mapping_id(p, "/manifest");
            let (status, value) = crate::p2p::protocol::handle_manifest(caller, &id).await;
            json_answer(status, value)
        }
        p if p.ends_with("/status") => {
            let id = album_mapping_id(p, "/status");
            let (status, value) = crate::p2p::protocol::handle_status(caller, &id).await;
            json_answer(status, value)
        }
        p if p.ends_with("/leave") => {
            let id = album_mapping_id(p, "/leave");
            let (status, value) = crate::p2p::protocol::handle_leave(caller, &id);
            json_answer(status, value)
        }
        // "Look at this album again." Says nothing about what changed and carries no address, so a
        // peer can only ever cause a re-read of a mapping that is already its own.
        p if p.ends_with("/nudge") => {
            let id = album_mapping_id(p, "/nudge");
            let (status, value) = crate::p2p::protocol::handle_nudge(caller, &id);
            json_answer(status, value)
        }
        // "What I publish has changed — read my index again." The same contract one level up: no
        // names and no albums, so a peer can only cause a re-read of what the caller already offers.
        "/index/nudge" => {
            let (status, value) = crate::p2p::protocol::handle_index_nudge(caller);
            json_answer(status, value)
        }
        // A person's picture, so their stand-in on the other server wears their face rather than the
        // addon's. Enrolled AND actually related: an avatar is personal data, not a public asset.
        p if p.starts_with("/users/") && p.ends_with("/avatar") => {
            serve_peer_avatar(caller, p).await
        }
        // Byte reads. Entitlement is checked inside, because "who is calling" and "what may they
        // read" are different questions and only the second one guards a photo.
        p if crate::media::proxy::byte_route(p).is_some() => {
            let (asset_id, kind) = crate::media::proxy::byte_route(p).expect("just matched");
            let state = crate::state::state();
            let client = crate::immich::client::Client::new();
            let range = header.range.as_deref();
            crate::media::proxy::serve_peer_bytes(state, &client, caller, &asset_id, &kind, range).await
        }
        // The share-link enrolment. The SETTING is honoured here, not only on the share page: a
        // card that is hidden while the join still succeeds is a setting that lies.
        "/invites/redeem" => {
            if !crate::p2p::protocol::share_link_joining_enabled() {
                return json_answer(
                    403,
                    json!({ "error": "this server does not accept album joins via shared links" }),
                );
            }
            let (status, value) = crate::p2p::protocol::handle_redeem(caller, body).await;
            json_answer(status, value)
        }
        "/pair" => {
            let Some(transport) = crate::p2p::transport::transport() else {
                return json_answer(503, json!({ "error": "the peer transport is not running" }));
            };
            let (status, value) = crate::p2p::pair::handle_pair(transport, caller, body).await;
            json_answer(status, value)
        }
        // `{protocol, version, features}` is how peers learn each other's capabilities. The
        // VERSION is free-form and informational; nothing may ever branch on it — features and
        // protocol are what a peer decides with, so that a build can change its version string
        // without any peer changing behaviour.
        "/hello" => json_answer(
            200,
            json!({
                "protocol": PROTOCOL_VERSION,
                "version": SIDECAR_VERSION,
                "features": PROTOCOL_FEATURES,
            }),
        ),
        _ => json_answer(404, json!({ "error": "unknown route" })),
    }
}

/// The `:id` from an `/albums/:id/<suffix>` route.
fn album_mapping_id(path: &str, suffix: &str) -> String {
    path.strip_prefix("/albums/")
        .and_then(|rest| rest.strip_suffix(suffix))
        .unwrap_or_default()
        .to_string()
}

/// The shape every JSON peer route answers with: a lowercase `content-type`, and no other headers.
pub fn json_answer(status: u16, value: serde_json::Value) -> PeerAnswer {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    PeerAnswer {
        status,
        headers: Some(headers),
        body: crate::p2p::transport::PeerBody::Bytes(value.to_string().into_bytes()),
    }
}

/// `GET /users/:userId/avatar` — one person's picture, for the stand-in that speaks for them here.
///
/// Enrolled AND related: an avatar is personal data, so a peer with no live share with this household
/// is answered 403 rather than being allowed to enumerate faces.
async fn serve_peer_avatar(caller: &str, path: &str) -> PeerAnswer {
    let state = crate::state::state();
    // ONE guard: `collections()` is not reentrant, so looking the peer and the mappings up with two
    // calls in one expression deadlocks the thread against its own lock.
    let related = {
        let collections = state.collections();
        collections.peers.iter().any(|p| p.pub_key == caller)
            && collections.mappings.iter().any(|m| m.peer == caller && !m.dead)
    };
    if !related {
        return json_answer(403, json!({ "error": "unknown peer" }));
    }
    let Some(user_id) = path
        .strip_prefix("/users/")
        .and_then(|rest| rest.strip_suffix("/avatar"))
        .filter(|id| !id.is_empty() && !id.contains('/'))
    else {
        return json_answer(404, json!({ "error": "no avatar" }));
    };
    let client = crate::immich::client::shared();
    let Ok(response) = client
        .request(
            reqwest::Method::GET,
            &format!("/users/{user_id}/profile-image"),
            &crate::immich::client::Auth::Admin,
            &[],
        )
        .await
    else {
        return json_answer(404, json!({ "error": "no avatar" }));
    };
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = response.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), content_type);
    PeerAnswer {
        status: 200,
        headers: Some(headers),
        body: crate::p2p::transport::PeerBody::Bytes(bytes),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(path: &str) -> (u16, serde_json::Value) {
        let answer = futures_lite::future::block_on(route(
            "some-peer",
            &RequestHeader { path: path.to_string(), ..Default::default() },
            &[],
        ));
        let bytes = match answer.body {
            crate::p2p::transport::PeerBody::Bytes(b) => b,
            _ => panic!("the JSON routes answer with bytes"),
        };
        (answer.status, serde_json::from_slice(&bytes).unwrap())
    }

    #[test]
    fn hello_names_the_protocol_the_version_and_the_feature_list() {
        let (status, body) = ask("/hello");
        assert_eq!(status, 200);
        assert_eq!(body["protocol"], PROTOCOL_VERSION);
        assert_eq!(body["protocol"], 2, "the wire major");
        assert_eq!(body["features"], json!(PROTOCOL_FEATURES));
        assert_eq!(body["features"][0], "sync-status");
        // The version is free-form: a build may change it without any peer changing behaviour.
        assert!(body["version"].is_string());
    }

    #[test]
    fn an_unknown_route_is_404_rather_than_a_dropped_stream() {
        let (status, body) = ask("/nope");
        assert_eq!(status, 404);
        assert_eq!(body["error"], "unknown route");
    }

    #[test]
    fn json_routes_carry_a_lowercase_content_type_and_no_others() {
        let answer = futures_lite::future::block_on(route(
            "p",
            &RequestHeader { path: "/hello".into(), ..Default::default() },
            &[],
        ));
        let headers = answer.headers.unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn the_feature_list_is_exactly_what_the_handshake_advertises() {
        // Adding a name here is safe; removing one is a compatibility decision.
        assert_eq!(PROTOCOL_FEATURES, ["sync-status"]);
    }
}
