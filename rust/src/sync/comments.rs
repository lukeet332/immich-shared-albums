/** sync/comments.rs — cross-server comment sync. See PORT.md. */
use crate::config::{cfg, person_name};
use crate::immich::client::{users_by_id, Auth, Client};
use crate::immich::contributors::ensure_contributor;
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::{Mapping, Peer, Role};
use crate::sync::house_bot::ensure_house_bot;
use crate::sync::peer_mapping_id::peer_album_mapping_id;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

/// The credential that can read an album's activity.
///
/// For a MIRROR the admin key is not a safe default: a per-person invitation adds only the one
/// invited human, so the sidecar's own admin may not be a member at all and Immich answers
/// `400 Not found or no album.read access` on every poll. The mirror-owning stand-in always has
/// access, because it owns the album. An owner mapping keeps the household key.
fn album_reader_auth(state: &State, mapping: &Mapping) -> Result<crate::immich::access::MappingAuth, String> {
    crate::immich::access::MappingAuth::for_mapping(state, mapping)
}

async fn get_comments(client: &Client, album_id: &str, auth: &Auth<'_>) -> Result<Vec<Value>, String> {
    // NO type filter: Immich's activities are comments AND likes, and both belong to the
    // conversation a joiner is looking at. Callers branch on the row's own `type`.
    let path = format!("/activities?albumId={album_id}");
    client
        .get(&path, auth)
        .await
        .map_err(|e| e.message())
        .map(|v| v.and_then(|v| v.as_array().cloned()).unwrap_or_default())
}

/// Post one activity of ANY kind. A like carries no text, which is Immich's own shape for it.
pub(crate) fn post_activity<'a>(
    client: &'a Client,
    album_id: &str,
    kind: &str,
    comment: &str,
    auth: &'a Auth<'a>,
) -> impl std::future::Future<Output = Result<Value, String>> + 'a {
    // Owned before the async block: the error message below would otherwise borrow `kind` across
    // the await, which is the one borrow this future cannot carry.
    let kind = kind.to_string();
    let mut body = json!({ "albumId": album_id, "type": kind });
    if kind == "comment" {
        body["comment"] = json!(comment);
    }
    async move {
        client
            .json(reqwest::Method::POST, "/activities", auth, Some(&body))
            .await
            .map_err(|e| e.message())?
            .ok_or_else(|| format!("Immich answered without a {kind}"))
    }
}

pub(crate) fn post_comment<'a>(
    client: &'a Client,
    album_id: &str,
    comment: &str,
    auth: &'a Auth<'a>,
) -> impl std::future::Future<Output = Result<Value, String>> + 'a {
    let body = json!({ "albumId": album_id, "type": "comment", "comment": comment });
    async move {
        client
            .json(reqwest::Method::POST, "/activities", auth, Some(&body))
            .await
            .map_err(|e| e.message())?
            .ok_or_else(|| "Immich answered without a comment".to_string())
    }
}

/// Materialise foreign comments locally through the author's stand-in, skipping ids already seen.
///
/// The author is materialised so their words carry THEIR name: posting as our own bot would
/// attribute a peer's words to us, permanently. The one fallback is the house bot, and only for a
/// failure that can never succeed — the author is an account this household is not allowed to put on
/// the album (the peer's own bot, which only an album's owner can add).
pub async fn materialise_comments(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    comments: &[Value],
) -> Result<serde_json::Map<String, Value>, String> {
    let mut ids = serde_json::Map::new();
    for comment in comments {
        let remote_id = comment.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if remote_id.is_empty() {
            continue;
        }
        let tag = format!("remote:{remote_id}");
        if state.store.seen_act_has(&tag).unwrap_or(false) {
            continue;
        }
        let author = comment.get("author").and_then(|v| v.as_str()).unwrap_or(&peer.name);
        // The peer's own BOT is machinery, not a person: its audit lines are that household's record,
        // and materialising them here provisioned an account for it on THIS server — which is what
        // put a second "immich-shared-albums (bot)" in the user picker. Every build names its bot
        // identically, so the display name is the reliable signal.
        if author == crate::sync::house_bot::HOUSE_BOT_DISPLAY_NAME {
            continue;
        }
        let author_user_id = comment.get("authorUserId").and_then(|v| v.as_str());
        let text = comment.get("comment").and_then(|v| v.as_str()).unwrap_or_default();

        // The mirror's own stand-in, when there is one: see `album_reader_auth`.
        let host_key = mapping
            .host_slug
            .as_ref()
            .and_then(|slug| state.collections().contributors.get(slug).and_then(|c| c.api_key.clone()));

        // A LIKE is posted as a like: it renders as "X liked it" here, exactly as it did at home.
        // Owned, because the poster borrows it for the whole round trip.
        let kind = comment
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("comment")
            .to_string();
        let text = if kind == "comment" { text } else { "" };
        let posted = match ensure_contributor(
            state,
            client,
            author,
            &mapping.album_id,
            &crate::immich::contributors::host_auth(host_key.as_deref()),
            author_user_id,
            Some(&mapping.peer),
            true,
            false,
        )
        .await
        {
            Ok(contributor) => {
                let key = contributor.api_key.clone().unwrap_or_default();
                match post_activity(client, &mapping.album_id, &kind, text, &Auth::Key(&key)).await {
                    Ok(posted) => posted,
                    Err(e) if cannot_succeed(&e) => {
                        let bot = ensure_house_bot(state, client).await?;
                        let bot_key = bot.api_key.clone().unwrap_or_default();
                        post_activity(client, &mapping.album_id, &kind, text, &Auth::Key(&bot_key))
                            .await
                            .map_err(|e| e.to_string())?
                    }
                    // A transient failure is RETURNED so the loop retries it: mirroring one as our
                    // bot would attribute words to it permanently, on the strength of a timeout.
                    Err(e) => return Err(e),
                }
            }
            Err(e) if cannot_succeed(&e) => {
                let bot = ensure_house_bot(state, client).await?;
                let bot_key = bot.api_key.clone().unwrap_or_default();
                post_activity(client, &mapping.album_id, &kind, text, &Auth::Key(&bot_key))
                    .await
                    .map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e),
        };

        let local_id = posted.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let _ = state.store.seen_act_add(&tag, &mapping.id);
        // Do not echo it back to where it came from.
        let _ = state.store.seen_act_add(&format!("local:{local_id}"), &mapping.id);
        ids.insert(remote_id.to_string(), json!(local_id));
        crate::log!("synced comment from \"{author}\" into \"{}\"", mapping.album_name);
    }
    Ok(ids)
}

/// Whether a failure is one that retrying cannot fix.
///
/// The permission/refusal family, and nothing else: a timeout or a 5xx is transient and must be
/// retried, because the fallback is not free — it posts the words under our bot's name.
fn cannot_succeed(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("activity.create")
        || lowered.contains("not a member")
        || lowered.contains("forbidden")
        || lowered.contains("403")
}

/// Tell every OTHER linked household that this album's conversation moved.
///
/// Fire-and-forget by contract: a nudge says "look again" and can never say what to look at, so
/// losing one costs the latency of the next sweep and nothing else. Only OWNER mappings nudge — a
/// member's mirror is not the source of truth, and nudging from it would have every household
/// telling every other one to re-read.
pub fn nudge_peers(state: &State, album_id: &str, except_peer_pub: Option<&str>) {
    let Some(transport) = transport() else { return };
    let targets: Vec<Peer> = {
        let collections = state.collections();
        collections
            .mappings
            .iter()
            .filter(|m| {
                m.album_id == album_id
                    && !m.dead
                    && m.role == Role::Owner
                    && Some(m.peer.as_str()) != except_peer_pub
            })
            .filter_map(|m| collections.peers.iter().find(|p| p.pub_key == m.peer).cloned())
            .collect()
    };
    for peer in targets {
        let transport = transport.clone();
        let path = format!("/albums/{album_id}/nudge");
        // Deliberately NOT awaited: the caller is answering a peer, and a nudge that blocks that
        // answer would make one household's latency another's.
        tokio::spawn(async move {
            let header = RequestHeader { path, ..Default::default() };
            let _ = transport.round_trip(&peer, &header, None).await;
        });
    }
}

/// `POST /albums/:id/activity` — a peer hands us comments to place in our album.
pub async fn handle_activity(
    state: &State,
    client: &Client,
    caller_pub: &str,
    mapping_id: &str,
    body: &[u8],
) -> (u16, Value) {
    let Some(peer) = state.collections().peers.iter().find(|p| p.pub_key == caller_pub).cloned()
    else {
        return (403, json!({ "error": "unknown peer", "code": "unknown_peer" }));
    };
    let Some(mapping) = crate::p2p::protocol::mapping_for(state, &peer.pub_key, mapping_id, None)
    else {
        return (404, json!({ "error": "unknown album mapping", "code": "unknown_mapping" }));
    };
    // DELIBERATELY no permissions gate: view-only governs PHOTOS, not conversation. A shared album
    // is still a shared space to talk in, and revoking upload rights must not mute anyone.
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(parsed) => parsed,
        Err(e) => return (400, json!({ "error": format!("malformed body: {e}") })),
    };
    let comments = parsed.get("comments").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    match materialise_comments(state, client, &mapping, &peer, &comments).await {
        Ok(ids) => {
            if !ids.is_empty() {
                // New messages, so tell the others — other member households included.
                nudge_peers(state, &mapping.album_id, Some(&peer.pub_key));
            }
            (200, json!({ "ok": true, "ids": Value::Object(ids) }))
        }
        Err(e) => (500, json!({ "error": e })),
    }
}

/// `GET /albums/:id/comments` — the canonical list. The ORIGIN is the source of truth.
pub async fn handle_comments(
    state: &State,
    client: &Client,
    caller_pub: &str,
    mapping_id: &str,
) -> (u16, Value) {
    let Some(peer) = state.collections().peers.iter().find(|p| p.pub_key == caller_pub).cloned()
    else {
        return (403, json!({ "error": "unknown peer" }));
    };
    // `owner`: only the household that owns the album answers for it. A member answering would let
    // a third household read a mirror's partial view as if it were canonical.
    let Some(mapping) =
        crate::p2p::protocol::mapping_for(state, &peer.pub_key, mapping_id, Some(Role::Owner))
    else {
        return (404, json!({ "error": "unknown album mapping", "code": "unknown_mapping" }));
    };
    let users = users_by_id(client, 10_000).await;
    // An owner mapping reads as the household; a member mapping reads as the stand-in that owns the
    // mirror, and is refused when this household holds no key for it.
    let Ok(creds) = album_reader_auth(state, &mapping) else {
        return (500, json!({ "error": "could not read the album's activity" }));
    };
    let auth = creds.auth();
    let Ok(activities) = get_comments(client, &mapping.album_id, &auth).await else {
        return (500, json!({ "error": "could not read the album's activity" }));
    };
    let comments: Vec<Value> = activities
        .iter()
        .filter(|a| {
            // Comments with text, and likes. A LIKE carries no text, so a text-only filter is what
            // kept them from ever leaving this server.
            let is_comment = a.get("comment").and_then(|c| c.as_str()).map(|c| !c.is_empty()).unwrap_or(false);
            let is_like = a.get("type").and_then(|t| t.as_str()) == Some("like");
            if !(is_comment || is_like) {
                return false;
            }
            // And OUR OWN machinery's lines stay here: the trail is this household's record, and
            // mirroring it elsewhere provisioned an account for OUR bot on THEIR server — which is
            // what put a second "immich-shared-albums (bot)" in their user picker.
            let is_utility = a
                .pointer("/user/id")
                .and_then(|v| v.as_str())
                .map(|id| users.get(id).map(|u| u.utility).unwrap_or(false))
                .unwrap_or(false);
            !is_utility
        })
        .map(|a| {
            let user = a.get("user").cloned().unwrap_or(Value::Null);
            let id = user.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let record = users.get(id);
            let raw = record
                .map(|u| u.name.clone())
                .or_else(|| user.get("name").and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_else(|| cfg().name.clone());
            // Strip the "(via …)" decoration only from BOT authors — a human genuinely named with a
            // trailing parenthesis must travel as written.
            let author = match record {
                Some(u) if u.utility => person_name(Some(&raw)).to_string(),
                _ => raw,
            };
            json!({
                "id": a.get("id").cloned().unwrap_or(Value::Null),
                // The kind rides the canonical list: a joiner must know a like is a like.
                "type": a.get("type").cloned().unwrap_or(json!("comment")),
                "comment": a.get("comment").cloned().unwrap_or(Value::Null),
                "createdAt": a.get("createdAt").cloned().unwrap_or(Value::Null),
                "author": if author.is_empty() { cfg().name.clone() } else { author },
                "authorUserId": user.get("id").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    (200, json!({ "comments": comments }))
}

/// Never overlapping: a slow pass must not be joined by the next tick, or one lagging album
/// multiplies into N concurrent reads of the same thing.
static COMMENTS_RUNNING: AtomicBool = AtomicBool::new(false);

/// The fast lane: the activity COUNT is one indexed query, so a seconds-level cadence stays cheap
/// and the full activity fetch runs only when the count moved.
pub async fn sync_comments_once(state: &State, client: &Client) {
    let ids: Vec<String> = state.collections().mappings.iter().map(|m| m.id.clone()).collect();
    for id in ids {
        let Some(mapping) = state.collections().mappings.iter().find(|m| m.id == id).cloned() else {
            continue;
        };
        if mapping.dead {
            continue;
        }
        let Some(peer) =
            state.collections().peers.iter().find(|p| p.pub_key == mapping.peer).cloned()
        else {
            continue;
        };
        if let Err(e) = sync_one_album(state, client, &mapping, &peer).await {
            crate::log!("comment sync error on \"{}\": {e}", mapping.album_name);
        }
    }
}

async fn sync_one_album(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
) -> Result<(), String> {
    // A member pulls the canonical set first: the origin is the source of truth, and this is also
    // what relays one member's comments onward to the others.
    if mapping.role == Role::Member {
        pull_canonical_comments(state, client, mapping, peer).await;
    }

    let creds = album_reader_auth(state, mapping)?;
    let auth = creds.auth();
    let stats = client
        .get(&format!("/activities/statistics?albumId={}", mapping.album_id), &auth)
        .await
        .ok()
        .flatten();
    // Comments AND likes: a like that moved must pass this gate or it is never pushed.
    let count = stats.as_ref().and_then(|s| {
        Some(
            s.get("comments").and_then(|v| v.as_i64()).unwrap_or(0)
                + s.get("likes").and_then(|v| v.as_i64()).unwrap_or(0),
        )
    });
    if let Some(count) = count {
        if Some(count) == mapping.comment_count {
            return Ok(());
        }
    }

    let utility_ids: Vec<String> = state
        .collections()
        .contributors
        .values()
        .filter_map(|c| c.user_id.clone())
        .collect();
    let activities = get_comments(client, &mapping.album_id, &auth).await?;
    let fresh: Vec<Value> = activities
        .into_iter()
        .filter(|a| {
            let id = a.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let author_id = a.pointer("/user/id").and_then(|v| v.as_str()).unwrap_or_default();
            // Comments travel as text; likes travel as themselves. Both are conversation.
            let is_comment = a.get("comment").and_then(|c| c.as_str()).map(|c| !c.is_empty()).unwrap_or(false);
            let is_like = a.get("type").and_then(|t| t.as_str()) == Some("like");
            (is_comment || is_like)
                && !state.store.seen_act_has(&format!("local:{id}")).unwrap_or(false)
                && !state.store.seen_act_has(&format!("remote:{id}")).unwrap_or(false)
                && !utility_ids.iter().any(|u| u == author_id)
        })
        .collect();

    let store_count = |state: &State, mapping: &Mapping, count: Option<i64>| {
        if let (Some(count), Some(live)) =
            (count, state.collections().mappings.iter_mut().find(|m| m.id == mapping.id))
        {
            live.comment_count = Some(count);
        }
        let _ = state.save();
    };

    if fresh.is_empty() {
        store_count(state, mapping, count);
        return Ok(());
    }

    let target = peer_album_mapping_id(mapping);
    if target.is_empty() {
        // A mirror with no remote id addresses nothing: `/albums//activity` is not a route, and the
        // comment stays pending rather than being posted at a stranger.
        crate::log!("no remote album id for \"{}\" — nothing to push comments to", mapping.album_name);
        return Ok(());
    }

    let payload: Vec<Value> = fresh
        .iter()
        .map(|a| {
            json!({
                "id": a.get("id").cloned().unwrap_or(Value::Null),
                // The kind rides the payload, the way `remove` rides the refs payload: an older peer
                // that never reads it gets comments exactly as before.
                "type": a.get("type").cloned().unwrap_or(json!("comment")),
                "comment": a.get("comment").cloned().unwrap_or(Value::Null),
                "author": a.pointer("/user/name").and_then(|v| v.as_str()).unwrap_or(&cfg().name),
                "authorUserId": a.pointer("/user/id").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let body = json!({ "comments": payload }).to_string();
    let header = RequestHeader { path: format!("/albums/{target}/activity"), ..Default::default() };
    let Some(transport) = transport() else { return Ok(()) };
    let (head, response) = transport
        .round_trip(peer, &header, Some(body.as_bytes()))
        .await
        .map_err(|e| e.to_string())?;
    if head.status >= 400 {
        return Ok(());
    }
    for activity in &fresh {
        if let Some(id) = activity.get("id").and_then(|v| v.as_str()) {
            let _ = state.store.seen_act_add(&format!("local:{id}"), &mapping.id);
        }
    }
    // The origin answers with canonical ids for our comments — remember them so the canonical pull
    // can never hand us our own comments back.
    if let Ok(parsed) = serde_json::from_slice::<Value>(&response) {
        if let Some(ids) = parsed.get("ids").and_then(|i| i.as_object()) {
            for origin_id in ids.values().filter_map(|v| v.as_str()) {
                let _ = state.store.seen_act_add(&format!("remote:{origin_id}"), &mapping.id);
            }
        }
    }
    store_count(state, mapping, count);
    crate::log!("pushed {} comment(s) to \"{}\"", fresh.len(), peer.name);
    Ok(())
}

/// Pull the origin's canonical comment set. Gated by the comment count in the version handshake, so
/// an unchanged conversation costs one small request.
pub async fn pull_canonical_comments(state: &State, client: &Client, mapping: &Mapping, peer: &Peer) {
    let target = mapping
        .remote_mapping_id
        .clone()
        .or_else(|| mapping.remote_album_id.clone())
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }
    let Some(transport) = transport() else { return };
    let version_header = RequestHeader { path: format!("/albums/{target}/version"), ..Default::default() };
    let Ok((head, body)) = transport.round_trip(peer, &version_header, None).await else { return };
    if head.status >= 400 {
        return;
    }
    let version: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(count) = version.get("comments").and_then(|v| v.as_i64()) else { return };
    if Some(count) == mapping.remote_comment_count {
        return;
    }
    let comments_header = RequestHeader { path: format!("/albums/{target}/comments"), ..Default::default() };
    let Ok((head, body)) = transport.round_trip(peer, &comments_header, None).await else { return };
    if head.status >= 400 {
        return;
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let comments = parsed.get("comments").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if materialise_comments(state, client, mapping, peer, &comments).await.is_err() {
        // Leave the cursor where it is: the next cycle retries rather than skipping the messages.
        return;
    }
    if let Some(live) = state.collections().mappings.iter_mut().find(|m| m.id == mapping.id) {
        live.remote_comment_count = Some(count);
    }
    let _ = state.save();
}

/// The comment lane's own loop, on its fast cadence.
pub fn start_comment_loop(state: std::sync::Arc<State>) {
    let period = std::time::Duration::from_millis(cfg().comment_poll_ms);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(period).await;
            // Held by a rig proving a change was pushed, not swept. BEFORE the tick counter: a held
            // lane did not look, and must not read as having looked.
            if crate::sync::sweeps::sweeps_are_paused() {
                continue;
            }
            if !crate::sync::sweeps::start_sweep("comments") {
                continue;
            }
            crate::sync::status::record_loop_tick(crate::sync::status::LoopName::Comments);
            if COMMENTS_RUNNING.swap(true, Ordering::SeqCst) {
                crate::sync::sweeps::finish_sweep("comments");
                continue;
            }
            sync_comments_once(&state, crate::immich::client::shared()).await;
            COMMENTS_RUNNING.store(false, Ordering::SeqCst);
            crate::sync::sweeps::finish_sweep("comments");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_refusal_that_cannot_succeed_is_retried_as_the_bot() {
        // The fallback posts a peer's words under OUR bot's name, so it must be reserved for the
        // case that has no other outcome. A timeout is not that case.
        assert!(cannot_succeed("immich /activities -> 403 Forbidden"));
        assert!(cannot_succeed("no activity.create access"));
        assert!(cannot_succeed("not a member of this album"));
        assert!(!cannot_succeed("timed out after 15s"));
        assert!(!cannot_succeed("immich /activities -> 500 Internal Server Error"));
        assert!(!cannot_succeed("connection reset by peer"));
    }
}
