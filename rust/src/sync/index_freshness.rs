//! sync/index_freshness.rs — offering a person's albums to linked peers from the traffic they already make. See PORT.md.

use crate::immich::access::Creds;
use crate::immich::client::Client;
use crate::state::State;
use crate::store::{Direction, OwnedAlbum, Peer};
use crate::sync::index_offer::{index_changed, should_refresh};
use crate::sync::album_index::albums_i_publish;

/// Credentials already seen, keyed by a fingerprint — the credential itself is never retained.
/// `user_id` is resolved once per session, which is what keeps a refresh down to a single call.
#[derive(Clone)]
struct Visit {
    last_visit_at: i64,
    last_refresh_at: i64,
    refreshes_with_no_change: u32,
    user_id: Option<String>,
    running: bool,
    /// A change arrived while a read was in flight: read again as soon as it lands, or an add-photos
    /// burst would be published only up to wherever the first read happened to get to.
    again: bool,
}

fn visits() -> &'static std::sync::Mutex<std::collections::HashMap<String, Visit>> {
    static VISITS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Visit>>> =
        std::sync::OnceLock::new();
    VISITS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Forget every session, so the next request looks like the first one. Test hook only: the quiet
/// period is fifteen minutes, which no test can wait out.
pub fn forget_visits() {
    if let Ok(mut visits) = visits().lock() {
        visits.clear();
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A fingerprint of the credential headers, so one person's session is one entry without the
/// credential ever being kept.
fn fingerprint(creds: &Creds) -> String {
    use sha2::{Digest, Sha256};
    let mut names: Vec<&String> = creds.headers.keys().collect();
    names.sort();
    let joined: String = names
        .iter()
        .map(|name| format!("{name}={}", creds.headers.get(*name).map(String::as_str).unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n");
    let digest = Sha256::digest(joined.as_bytes());
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, digest)
        .chars()
        .take(16)
        .collect()
}

/// A request that may have moved this person's albums: read them again, if it is worth reading.
///
/// Called on the way past, never in the way of it — the proxy streams uploads through here. An album
/// MUTATION is the index changing, so it is read at once (coalesced, because adding twenty photos is
/// one event in twenty requests); a SESSION marker is a person arriving, so it is read when the window
/// allows.
pub fn note_index_traffic(
    state: &std::sync::Arc<State>,
    trigger: crate::sync::traffic_triggers::TrafficTrigger,
    creds: Creds,
) {
    if state.collections().peers.is_empty() {
        return;
    }
    let forced = trigger == crate::sync::traffic_triggers::TrafficTrigger::Index;
    let key = fingerprint(&creds);
    let now = now_ms();
    {
        let Ok(mut visits) = visits().lock() else { return };
        if let Some(seen) = visits.get_mut(&key) {
            if seen.running {
                if forced {
                    seen.again = true;
                }
                return;
            }
            if !forced && !should_refresh(seen.last_visit_at, seen.last_refresh_at, seen.refreshes_with_no_change, now) {
                seen.last_visit_at = now;
                return;
            }
        }
        let previous = visits.get(&key).cloned();
        visits.insert(
            key.clone(),
            Visit {
                last_visit_at: now,
                last_refresh_at: now,
                refreshes_with_no_change: previous.as_ref().map(|v| v.refreshes_with_no_change).unwrap_or(0),
                user_id: previous.as_ref().and_then(|v| v.user_id.clone()),
                running: true,
                again: false,
            },
        );
        if visits.len() > 100 {
            visits.retain(|_, visit| now - visit.last_visit_at <= 24 * 60 * 60 * 1000);
        }
    }
    let owned_state = state.clone();
    tokio::spawn(async move {
        let known_user_id = visits().lock().ok().and_then(|v| v.get(&key).and_then(|v| v.user_id.clone()));
        let changed = offer_albums_from(&owned_state, &creds, known_user_id.as_deref()).await;
        let Ok(mut open) = visits().lock() else { return };
        let (again, still_there) = match open.get_mut(&key) {
            Some(visit) => {
                // The window answers to the EVIDENCE: a change means this person is working on their
                // library and the next look is worth a minute; nothing means the wait doubles.
                visit.refreshes_with_no_change =
                    if changed || forced { 0 } else { visit.refreshes_with_no_change + 1 };
                let again = visit.again;
                visit.running = false;
                visit.again = false;
                (again, true)
            }
            None => (false, false),
        };
        drop(open);
        if again && still_there {
            schedule_refresh(&owned_state, key, creds);
        }
    });
}

/// Start a read for this credential because a change arrived mid-flight.
fn schedule_refresh(state: &std::sync::Arc<State>, key: String, creds: Creds) {
    let Ok(mut open) = visits().lock() else { return };
    let Some(visit) = open.get_mut(&key) else { return };
    if visit.running {
        visit.again = true;
        return;
    }
    visit.running = true;
    visit.again = false;
    drop(open);
    let owned_state = state.clone();
    tokio::spawn(async move {
        let known_user_id = visits().lock().ok().and_then(|v| v.get(&key).and_then(|v| v.user_id.clone()));
        let changed = offer_albums_from(&owned_state, &creds, known_user_id.as_deref()).await;
        if let Ok(mut open) = visits().lock() {
            if let Some(visit) = open.get_mut(&key) {
                visit.refreshes_with_no_change = if changed { 0 } else { visit.refreshes_with_no_change + 1 };
                visit.running = false;
            }
        }
    });
}

/// Read this person's albums as them and offer them to every linked peer.
///
/// Returns whether a peer was actually told to look again, which is the only evidence the freshness
/// window is allowed to react to.
pub async fn offer_albums_from(
    state: &State,
    creds: &Creds,
    known_user_id: Option<&str>,
) -> bool {
    let user_id = match known_user_id {
        Some(id) => Some(id.to_string()),
        None => user_id_for(&crate::immich::client::shared(), creds).await,
    };
    let Some(user_id) = user_id else {
        return false; // not a person: nothing of ours to offer
    };
    if known_user_id.is_none() {
        remember_user_id(creds, &user_id);
    }
    let Some(albums) = crate::immich::access::read_caller_albums(&crate::immich::client::shared(), creds).await
    else {
        return false;
    };
    offer_to_every_peer(state, &albums_i_publish(&albums, &user_id), &user_id) > 0
}

fn remember_user_id(creds: &Creds, user_id: &str) {
    let key = fingerprint(creds);
    if let Ok(mut visits) = visits().lock() {
        if let Some(visit) = visits.get_mut(&key) {
            visit.user_id = Some(user_id.to_string());
        }
    }
}

/// The person behind a credential, or `None` when Immich will not resolve it or it turns out to be one
/// of our own accounts.
async fn user_id_for(client: &Client, creds: &Creds) -> Option<String> {
    let me = client
        .get("/users/me", &crate::immich::client::Auth::Creds(creds))
        .await
        .ok()
        .flatten()?;
    let email = me.get("email").and_then(|v| v.as_str());
    if crate::config::is_utility_email(email) {
        return None;
    }
    me.get("id").and_then(|v| v.as_str()).map(str::to_string)
}

/// The admin account's own albums, read with the configured key.
///
/// The admin IS a person here — an account this addon minted for itself is never the configured key's
/// owner — so this is what lets a link be useful the moment it exists, with no session in hand: the
/// peer that just paired is told what to match against before anyone opens a panel.
pub async fn offer_admin_albums(state: &State) -> bool {
    let client = crate::immich::client::shared();
    let Some(me) = client
        .get("/users/me", &crate::immich::client::Auth::Admin)
        .await
        .ok()
        .flatten()
    else {
        return false;
    };
    if crate::config::is_utility_email(me.get("email").and_then(|v| v.as_str())) {
        return false;
    }
    let Some(user_id) = me.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
        return false;
    };
    // NO credentials argument: the admin key is the configured one, and passing an empty credential
    // instead reads as `401 Authentication required` — which is how a fresh link ends up with nothing
    // offered on the side that minted it.
    let Some(albums) = client.get("/albums", &crate::immich::client::Auth::Admin).await.ok().flatten()
    else {
        return false;
    };
    let Some(albums) = albums.as_array().cloned() else { return false };
    offer_to_every_peer(state, &albums_i_publish(&albums, &user_id), &user_id) > 0
}

/// Offer one person's albums to every peer, nudging only the peers whose view actually changed.
fn offer_to_every_peer(state: &State, mine: &[OwnedAlbum], owner_user_id: &str) -> usize {
    let peers: Vec<Peer> = state.collections().peers.clone();
    let mut nudged = 0usize;
    for peer in peers {
        let before = state
            .store
            .published_albums_for(&peer.pub_key, Direction::ToThem)
            .unwrap_or_default()
            .into_iter()
            .filter(|album| album.owner_user_id.as_deref() == Some(owner_user_id))
            .collect::<Vec<_>>();
        // UNCHANGED IS FREE: no row is rewritten and no peer is dialled, so a refresh that finds the
        // same albums costs the two reads above and nothing else.
        if !index_changed(&before, mine) {
            continue;
        }
        crate::sync::album_index::offer_albums_to(state, mine, owner_user_id, &peer.pub_key);
        nudge_peer_index(&peer);
        nudged += 1;
    }
    if nudged > 0 {
        crate::log!("offered {} album(s) — told {nudged} peer(s) to look again", mine.len());
    }
    nudged
}

/// Tell a peer its view of what we offer may have changed, so it re-reads rather than waiting for its
/// next sweep. Carries nothing: the peer re-reads what we already publish for it.
fn nudge_peer_index(peer: &Peer) {
    let Some(transport) = crate::p2p::transport::transport() else { return };
    let peer = peer.clone();
    tokio::spawn(async move {
        let header = crate::p2p::frame::RequestHeader { path: "/index/nudge".into(), ..Default::default() };
        let _ = transport.round_trip(&peer, &header, None).await;
    });
}
