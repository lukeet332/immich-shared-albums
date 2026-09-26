/** sync/directory.rs — the people each server offers, and the invite targets it creates. See PORT.md. */
use crate::config::{bot_prefix, cfg, is_utility_email, marker_name, UTILITY_EMAIL_DOMAIN};
use crate::immich::client::{Auth, Client};
use crate::immich::contributors::{ensure_utility_user, ContributorSpec};
use crate::p2p::frame::RequestHeader;
use crate::sync::peer_mapping_id::peer_album_mapping_id;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::{Peer, Role};
use serde_json::{json, Value};

/// The people THIS household offers a linked server, so that server can offer them as invite
/// targets in its own Immich picker.
///
/// NAMES ONLY — never emails, and never the bot accounts. An Immich email is a login identifier, so
/// sending it would hand a linked household the first half of a credential for every user here; a
/// picker needs only names, so nothing is given up.
///
/// Off entirely when `ISA_PUBLISH_USER_DIRECTORY=false`, which disables native invitations with that
/// peer: sharing is per person, so with no directory there is nobody to name. Share links still work.
pub async fn local_directory(client: &Client) -> Vec<Value> {
    if !cfg().publish_user_directory {
        return Vec::new();
    }
    let users = client
        .get("/admin/users", &Auth::Admin)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    users
        .iter()
        .filter(|u| u.get("deletedAt").map(|d| d.is_null()).unwrap_or(true))
        .filter(|u| !is_utility_email(u.get("email").and_then(|e| e.as_str())))
        .filter_map(|u| {
            let id = u.get("id").and_then(|v| v.as_str())?;
            let name = u.get("name").and_then(|v| v.as_str())?;
            Some(json!({ "id": id, "name": name }))
        })
        .collect()
}

/// Mirror a peer's directory into local invite-target stand-ins, one per remote person, so they
/// appear in Immich's own album picker.
///
/// Named `<person> (via <server> server)` rather than carrying the generic utility suffix: in a
/// picker you are choosing a DESTINATION, so the name says where the album is going. That is the
/// whole reason `marker_name` exists separately from the attribution bot's naming.
pub async fn sync_peer_directory(state: &State, client: &Client, peer: &Peer) -> usize {
    let started = std::time::Instant::now();
    let people_seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let Some(transport) = transport() else { return 0 };
    let header = RequestHeader { path: "/directory".into(), ..Default::default() };
    // Bounded: a person is not waiting on this, but the invite loop is, and an unreachable peer must
    // not hold the whole cycle.
    let Ok(Ok((head, body))) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        transport.round_trip(peer, &header, None),
    )
    .await
    else {
        return 0;
    };
    // A peer too old to know the route answers 404, which is "peer too old", not an error.
    if head.status >= 400 {
        return 0;
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let people = parsed.get("users").and_then(|u| u.as_array()).cloned().unwrap_or_default();

    let mut created = 0usize;
    for person in people {
        let (Some(id), Some(name)) = (
            person.get("id").and_then(|v| v.as_str()),
            person.get("name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let state_key = format!("{}{id}", bot_prefix::PERSON);
        // `homePeer` is set HERE and only here, because a directory is the one thing that proves
        // where a person lives. Everything else — a ref, a relayed photo — names the person without
        // naming their server, and guessing would route an album to the wrong household.
        let spec = ContributorSpec {
            display_name: name.to_string(),
            full_name: Some(marker_name::person(name, &peer.name)),
            state_key: state_key.clone(),
            email: format!("{state_key}@{UTILITY_EMAIL_DOMAIN}"),
            via_peer: Some(peer.pub_key.clone()),
            peer_user_id: Some(id.to_string()),
            home_peer: Some(peer.pub_key.clone()),
            permissions: None,
        };
        people_seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match ensure_utility_user(state, client, &spec).await {
            Ok(existing) => {
                if existing.api_key.is_none() {
                    created += 1;
                }
            }
            Err(e) => crate::log!("could not create an invite target for \"{name}\": {e}"),
        }
    }
    crate::log!(
        "directory sync \"{}\": {} people, {} new, {}ms",
        peer.name,
        people_seen.load(std::sync::atomic::Ordering::Relaxed),
        created,
        started.elapsed().as_millis()
    );
    created
}

/// At most one index refresh in flight. Deliberately NOT awaited by the tick: the refresh dials every
/// peer (each bounded), and a tick that waited on a peer's dial is how a retirement that should take
/// one cycle takes two minutes.
static INDEX_REFRESH_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Refresh every peer's published index once, unless a refresh is already running.
fn refresh_peer_indexes_once(state: &std::sync::Arc<State>) {
    use std::sync::atomic::Ordering;
    if INDEX_REFRESH_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        struct ClearRunning;
        impl Drop for ClearRunning {
            fn drop(&mut self) {
                INDEX_REFRESH_RUNNING.store(false, Ordering::SeqCst);
            }
        }
        let _clear = ClearRunning;
        crate::sync::album_index::refresh_peer_indexes(&state).await;
    });
}

/// The directory lane, which is also the invite lane: keep every linked peer's invite targets current,
/// turn a membership a human made into an invitation, mirror what this household has been invited to,
/// and refresh the album indexes while we are talking to the peers anyway.
///
/// ORDER IS LOAD-BEARING: the directories run first because detection asks each invited person's
/// MARKER what it can see, and with no markers there is nobody to ask.
pub fn start_directory_loop(state: std::sync::Arc<State>) {
    let period = std::time::Duration::from_millis(cfg().sync_poll_ms);
    tokio::spawn(async move {
        let client = crate::immich::client::shared();
        loop {
            tokio::time::sleep(period).await;
            // Held by a rig proving a change was pushed, not swept. Before the tick counter: a held
            // lane did not look, and must not read as having looked.
            if crate::sync::sweeps::sweeps_are_paused() {
                continue;
            }
            if !crate::sync::sweeps::start_sweep("invites") {
                continue;
            }
            crate::sync::status::record_loop_tick(crate::sync::status::LoopName::Invites);
            let peers: Vec<Peer> = state.collections().peers.clone();
            for peer in peers {
                sync_peer_directory(&state, client, &peer).await;
            }
            // Detection AFTER the directories: it asks each invited person's marker what it can see,
            // and with no markers there is nobody to ask.
            match crate::sync::invites::detect_invites_once(&state, client).await {
                0 => {}
                n => crate::log!("{n} new invitation(s) detected"),
            }
            // And the other half of membership: a link join ends when its LINK does. On this loop
            // because it is the one that already asks "who is still allowed in" — and because a
            // withdrawal has to be noticed before anything can be said about it in the album.
            crate::sync::link_grants::retire_withdrawn_link_grants(&state, client).await;
            // ...and a peer can go silent on an album WITHOUT this side changing anything: an unlink
            // binds the transport for the handshakes below, once per tick.
            let mesh_transport = transport().expect("the invite loop needs the transport");
            // ...and a peer can go silent on an album WITHOUT this side changing anything: an unlink
            // deletes the peer's mappings, so our album sits untouched and the push path never
            // fires, and the share would look live for ever. One cheap handshake per live share
            // answers it, and the same retirement counter the push uses does the rest.
            // The guard is bound in its own statement and dropped before the awaits below: holding
            // it across an await makes the whole spawned loop non-Send (PORT.md's guard rule).
            let live_shares: Vec<crate::store::Mapping> = {
                let collections = state.collections();
                collections
                    .mappings
                    .iter()
                    .filter(|m| m.role == Role::Owner && !m.dead)
                    .cloned()
                    .collect()
            };
            for mapping in live_shares {
                let peer_record = {
                    let collections = state.collections();
                    collections
                        .peers
                        .iter()
                        .find(|p| p.pub_key == mapping.peer)
                        .cloned()
                };
                let Some(peer) = peer_record else {
                    continue;
                };
                let header = RequestHeader {
                    path: format!("/albums/{}/version", peer_album_mapping_id(&mapping)),
                    ..Default::default()
                };
                let answered = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    mesh_transport.round_trip(&peer, &header, None),
                )
                .await;
                let counts = match answered {
                    Ok(Ok((head, _))) if head.status == 404 => true,
                    _ => false,
                };
                if !counts {
                    continue;
                }
                let n = {
                    let mut counts = crate::sync::engine::push_failures().lock().unwrap();
                    let n = counts.entry(mapping.id.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                if n >= crate::sync::engine::PUSH_404_DEAD_AFTER {
                    crate::sync::engine::push_failures().lock().unwrap().remove(&mapping.id);
                    crate::sync::engine::retire_dead_share(
                        &state,
                        client,
                        &mapping,
                        &peer,
                        &format!("peer answered 404 to {n} version checks in a row — it no longer has this album"),
                    )
                    .await;
                }
            }
            // Fire-and-forget, with one refresh in flight: the tick must not wait on a peer's dial,
            // and an unguarded spawn per tick is more parallelism than the behaviour it replaces had.
            refresh_peer_indexes_once(&state);
            // The member side of invitations. The TypeScript runs this from its invite loop every
            // tick and treats a peer's nudge as a latency SHORTCUT, not as the only trigger — so
            // without this, an invitation is mirrored only if a nudge happens to arrive, and the
            // suite's reach depends on timing. That is exactly the run-to-run variance this port
            // was measuring: 211 checks when the nudge fired, 181 when it did not.
            crate::sync::invites::pull_invitations_once(&state, client).await;
            crate::sync::sweeps::finish_sweep("invites");
        }
    });
}

/// People this household can actually invite to an album on `peer_pub`.
///
/// `home_peer == peer_pub` is the whole gate, and it is a SECURITY gate rather than tidiness.
/// Attribution accounts are also created from incoming refs, and a ref carries the person's own user
/// id but NOT their home server — for relayed content the ref's peer is the hop it travelled
/// through. Treating one of those as invitable would take an album a human shared with a person at D
/// and hand it to C. Only a linked server's directory proves where someone lives.
pub async fn invite_targets_for(
    state: &State,
    client: &Client,
    peer_pub: &str,
) -> Vec<(String, String, String)> {
    let candidates: Vec<(String, String)> = state
        .collections()
        .contributors
        .iter()
        .filter(|(_, c)| {
            c.home_peer.as_deref() == Some(peer_pub) && c.api_key.is_some() && c.user_id.is_some()
        })
        .map(|(slug, c)| (slug.clone(), c.user_id.clone().unwrap_or_default()))
        .collect();
    // The NAME lives in Immich, not in our record: a picker shows the account's own name, and the
    // stored slug is a key rather than a label.
    let users = crate::immich::client::users_by_id(client, 10_000).await;
    candidates
        .into_iter()
        .map(|(slug, user_id)| {
            let name = users
                .get(&user_id)
                .map(|u| u.name.clone())
                .unwrap_or_else(|| slug.clone());
            (slug, user_id, name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marker_names_the_destination_and_never_carries_the_generic_suffix() {
        // In a picker a person is choosing where an album GOES, so the name must say so — and it
        // must not read as an attribution stand-in, which is a different account kind.
        let marker = marker_name::person("Nan", "The Smiths");
        assert_eq!(marker, "Nan (via The Smiths server)");
        assert!(!marker.ends_with(crate::config::UTILITY_SUFFIX));
        // A server whose name already ends in "server" does not get it twice.
        assert_eq!(marker_name::person("Nan", "Demo household (B) server"), "Nan (via Demo household (B) server)");
    }

    #[test]
    fn the_directory_never_carries_an_email() {
        // The shape the route answers with. An email is a login identifier, so a picker that needs
        // only names must not receive one.
        let entry = json!({ "id": "u1", "name": "Nan" });
        assert!(entry.get("email").is_none());
        assert!(entry.get("id").is_some() && entry.get("name").is_some());
    }
}
