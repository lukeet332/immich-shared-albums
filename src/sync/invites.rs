/** sync/invites.rs — native album invitations, per person. See ARCHITECTURE.md. */
use crate::config::short_id;
use crate::immich::access::{read_caller_albums, Creds};
use crate::immich::client::Client;
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::{Mapping, Peer, Role};
use crate::sync::host_keys::host_key_of;
use crate::sync::invitees::{diff_invitees, invitation_mirror_was_withdrawn};
use crate::sync::peer_mapping_id::peer_of;
use serde_json::{json, Value};

/// Immich album roles map onto the permission a share link would have carried.
pub fn permission_for(role: Option<&str>) -> &'static str {
    if role == Some("editor") {
        "contribute"
    } else {
        "view"
    }
}

/// The permission a household's markers COMBINE to for one album: the more permissive of the two.
///
/// Several markers of one household may be invited to the same album with different roles, and
/// whichever marker's album read happened to arrive first must not decide what gets mirrored — so
/// the merge is order-independent, the way `invitees` is unioned: if any marker holds `contribute`,
/// the household records `contribute`.
pub fn widest_permission(left: &str, right: &str) -> String {
    if left == "contribute" || right == "contribute" {
        "contribute".to_string()
    } else {
        right.to_string()
    }
}

/// A dead member mirror of the SAME share an invitation is about — replaceable, not a live mirror.
///
/// A mapping the watcher retired (transient read failures) lingers `dead` while the origin still
/// offers the share; re-mirroring without clearing it would create a SECOND mirror of one share,
/// the state a person cannot repair from the UI.
pub fn dead_mirror_of_the_same_share(mapping: &Mapping, peer_pub: &str, album_id: &str) -> bool {
    mapping.role == Role::Member
        && mapping.peer == peer_pub
        && mapping.dead
        && (mapping.remote_album_id.as_deref() == Some(album_id) || mapping.album_id == album_id)
}

/// What one marker can see, split into "invited to" and "merely visible".
///
/// The distinction is the whole detection rule, and it rests on a namespace guarantee: the sidecar
/// NEVER adds a per-person marker to an album, so a marker's membership can only have been created
/// by a human in Immich's own picker. The ATTRIBUTION contributors are the opposite — the sidecar
/// adds those whenever their owner contributes a photo, so their membership means "they contributed
/// here", not "someone invited them". Conflating the two turned every link-shared album into a bogus
/// invitation, and later made origin and member mirror/withdraw each other every poll.
#[derive(Default, Debug, PartialEq)]
pub struct MarkerSeen {
    /// album id -> (name, permissions, owner name, owner id)
    pub invited: std::collections::HashMap<String, Invited>,
    pub visible: std::collections::HashSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Invited {
    pub name: String,
    pub permissions: String,
    pub owner_name: Option<String>,
    pub owner_id: Option<String>,
}

pub async fn albums_as_marker(
    state: &State,
    client: &Client,
    marker_creds: &Creds,
    marker_user_id: &str,
) -> Option<MarkerSeen> {
    let albums = read_caller_albums(client, marker_creds).await?;
    let mut seen = MarkerSeen::default();
    for album in &albums {
        let Some(id) = album.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        seen.visible.insert(id.to_string());
        let members = album.get("albumUsers").and_then(|u| u.as_array());
        let mine = members.and_then(|list| {
            list.iter().find(|entry| {
                entry.pointer("/user/id").and_then(|v| v.as_str()) == Some(marker_user_id)
            })
        });
        // Membership gone, or ours as OWNER: drop any ledger row, so a future hand-invite to this
        // album still reads as intent rather than matching a stale row for ever.
        let Some(mine) = mine else {
            let _ = state.store.added_forget(id, marker_user_id);
            continue;
        };
        if mine.get("role").and_then(|r| r.as_str()) == Some("owner") {
            let _ = state.store.added_forget(id, marker_user_id);
            continue;
        }
        // WE put them here, for attribution. Not an invitation, however it looks.
        if state.store.added_has(id, marker_user_id).unwrap_or(false) {
            continue;
        }
        // A v3 album response carries no ownerId — the owner is only discoverable inside albumUsers.
        let owner = members.and_then(|list| {
            list.iter()
                .find(|entry| entry.get("role").and_then(|r| r.as_str()) == Some("owner"))
        });
        seen.invited.insert(
            id.to_string(),
            Invited {
                name: album
                    .get("albumName")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                permissions: permission_for(mine.get("role").and_then(|r| r.as_str())).to_string(),
                owner_name: owner
                    .and_then(|o| o.pointer("/user/name"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                owner_id: owner
                    .and_then(|o| o.pointer("/user/id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            },
        );
    }
    Some(seen)
}

/// Ask a peer to re-read its invitations now, rather than at its next sweep.
///
/// Fire-and-forget by contract: a nudge says "look again" and can never say what to look at, so
/// losing one costs the latency of the next tick and nothing else.
pub fn nudge_peer_invitations(peer: &Peer) {
    let Some(transport) = transport() else { return };
    let peer = peer.clone();
    tokio::spawn(async move {
        let header = RequestHeader {
            path: "/invitations/nudge".into(),
            ..Default::default()
        };
        let _ = transport.round_trip(&peer, &header, None).await;
    });
}

/// Origin side: turn native album invitations into mappings, and withdrawn ones into dead mappings.
///
/// One album list per invited person, asked as that person's MARKER — which is why the directory
/// lane must have run first: with no markers there is nobody to ask.
pub async fn detect_invites_once(state: &State, client: &Client) -> usize {
    let peers: Vec<Peer> = state.collections().peers.clone();
    let mut created = 0usize;
    for peer in peers {
        let targets =
            crate::sync::directory::invite_targets_for(state, client, &peer.pub_key).await;
        // No marker means the directory is not shared yet, or ISA_PUBLISH_USER_DIRECTORY is off —
        // sharing is per person, so there is nobody to name and nothing to detect.
        if targets.is_empty() {
            continue;
        }

        // Union every marker's view. Inviting two people from one household to one album must
        // mirror for both, so every person invited to a given album is remembered.
        let mut invited: std::collections::HashMap<String, Invited> =
            std::collections::HashMap::new();
        let mut visible: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut invitees: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let mut read_failed = false;

        for (slug, user_id, _name) in &targets {
            let Some(candidate) = state.collections().contributors.get(slug).cloned() else {
                continue;
            };
            // Empty = no key minted yet; this marker is not readable as them.
            let key = candidate.api_key.clone();
            if key.is_empty() {
                continue;
            }
            let creds = key_creds(state, &key);
            match albums_as_marker(state, client, &creds, user_id).await {
                Some(part) => {
                    crate::log!(
                        "marker {}: {} visible, {} invited",
                        short_id(user_id),
                        part.visible.len(),
                        part.invited.len()
                    );
                    for (id, entry) in part.invited {
                        if let Some(peer_user_id) = candidate.peer_user_id.clone() {
                            invitees.entry(id.clone()).or_default().push(peer_user_id);
                        }
                        // The COMBINED permission, not whichever marker was read first — see
                        // `widest_permission`.
                        invited
                            .entry(id)
                            .and_modify(|kept| {
                                kept.permissions =
                                    widest_permission(&kept.permissions, &entry.permissions);
                            })
                            .or_insert(entry);
                    }
                    visible.extend(part.visible);
                }
                None => {
                    // ABORT the peer on ANY read failure: a partial view is indistinguishable from a
                    // withdrawal, and acting on one would retire live shares.
                    crate::log!("could not read invitations for \"{}\"", peer.name);
                    read_failed = true;
                    break;
                }
            }
        }
        if read_failed {
            continue;
        }
        crate::log!(
            "detect \"{}\": markers read ({} invited, {} visible) — creating",
            peer.name,
            invited.len(),
            visible.len()
        );

        for (album_id, entry) in &invited {
            let for_peer_user_ids = invitees.get(album_id).cloned().unwrap_or_default();
            if for_peer_user_ids.is_empty() {
                continue; // invited nobody we can name — nothing to offer
            }
            let existing = state
                .collections()
                .mappings
                .iter()
                .find(|m| {
                    m.role == Role::Owner && m.peer == peer.pub_key && m.album_id == *album_id
                })
                .cloned();
            let Some(existing) = existing else {
                state.collections().mappings.push(Mapping {
                    id: crate::sync::mirror::new_uuid(),
                    role: Role::Owner,
                    album_id: album_id.clone(),
                    album_name: entry.name.clone(),
                    peer: peer.pub_key.clone(),
                    remote_album_id: None,
                    remote_mapping_id: None,
                    permissions: entry.permissions.clone(),
                    host_slug: None,
                    via: "invite".into(),
                    for_peer_user_ids: Some(for_peer_user_ids.clone()),
                    album_owner_name: entry.owner_name.clone(),
                    album_owner_id: entry.owner_id.clone(),
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
                });
                let _ = state.save();
                created += 1;
                // THE PERSON IT IS FOR SHOULD NOT HAVE TO WAIT FOR A SWEEP: tell their household to
                // pull now, the moment the share exists.
                nudge_peer_invitations(&peer);
                crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Shares);
                crate::log!(
                    "invited {} person(s) at \"{}\" to \"{}\" ({}) — shared natively, no link needed",
                    for_peer_user_ids.len(),
                    peer.name,
                    entry.name,
                    entry.permissions
                );
                continue;
            };
            // People added to or removed from the invite while the album stays shared.
            let mut changed = existing.dead;
            if existing.dead {
                crate::log!(
                    "invitation re-added: \"{}\" -> \"{}\"",
                    peer.name,
                    entry.name
                );
            }
            let mut sorted = for_peer_user_ids.clone();
            sorted.sort();
            let mut was = existing.for_peer_user_ids.clone().unwrap_or_default();
            was.sort();
            if was != sorted {
                changed = true;
                crate::log!(
                    "invitation for \"{}\" now names {} person(s) at \"{}\"",
                    entry.name,
                    for_peer_user_ids.len(),
                    peer.name
                );
            }
            if existing.permissions != entry.permissions {
                changed = true;
            }
            if changed {
                if let Some(live) = state
                    .collections()
                    .mappings
                    .iter_mut()
                    .find(|m| m.id == existing.id)
                {
                    live.dead = false;
                    live.dead_at = None;
                    live.dead_reason = None;
                    live.for_peer_user_ids = Some(for_peer_user_ids.clone());
                    live.permissions = entry.permissions.clone();
                }
                let _ = state.save();
            }
        }

        crate::log!("detect \"{}\": creates done — withdrawing", peer.name);
        // Withdrawals. ONLY mappings created from an invitation are eligible: a link-redeemed
        // mapping never had a stand-in added to its album, so it is absent from this list by design
        // and retiring it here would silently unshare every link-based album.
        //
        // And OWNER mappings only. This loop judges albums on OUR server by whether the peer's
        // marker is still a member. A MEMBER mapping is a mirror we received — the peer's markers
        // were never members of it, so it always looks withdrawn here, and retiring it would kill a
        // live mirror one poll after the pull created it. That is a mirror/withdraw loop, not a
        // withdrawal; member mappings are retired by the pull, against what the peer offers.
        let withdrawn: Vec<(String, String)> = state
            .collections()
            .mappings
            .iter()
            .filter(|m| {
                m.role == Role::Owner
                    && m.via == "invite"
                    && m.peer == peer.pub_key
                    && !m.dead
                    && !invited.contains_key(&m.album_id)
                    && !visible.contains(&m.album_id)
            })
            .map(|m| (m.id.clone(), m.album_name.clone()))
            .collect();
        for (id, name) in withdrawn {
            if let Some(live) = state.collections().mappings.iter_mut().find(|m| m.id == id) {
                live.dead = true;
                live.dead_at = Some(crate::config::iso_now());
                live.dead_reason = Some("invitation withdrawn".into());
            }
            let _ = state.save();
            nudge_peer_invitations(&peer);
            crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Shares);
            crate::log!(
                "invitation withdrawn: \"{}\" removed from \"{}\" — no longer syncing it (invited={} visible={})",
                peer.name,
                name,
                invited.len(),
                visible.len()
            );
        }
        crate::log!("detect \"{}\": pass complete", peer.name);
    }
    created
}

/// A caller's forwarded key as credentials, for reading as that marker.
fn key_creds(_state: &State, key: &str) -> Creds {
    let mut headers = std::collections::HashMap::new();
    headers.insert("x-api-key".to_string(), key.to_string());
    Creds { headers }
}

/// Reconcile one mirror's local membership against the people the invitation now names.
///
/// A sender can add or drop individual people without withdrawing the album. Follow it, or a
/// de-invited person keeps the mirror forever and revocation silently does nothing.
async fn sync_mirror_members(state: &State, client: &Client, mapping: &Mapping, wanted: &[String]) {
    // SILENT SKIP, deliberately: without the mirror-owning stand-in's key the album cannot be read
    // or widened at all, and the pull simply tries again next cycle.
    let Some(host_key) = host_key_of(state, mapping) else {
        return;
    };
    if mapping.adopted == Some(true) {
        // Adopted means a local human owns it, so the sidecar's key cannot change its membership
        // whoever the invitation names — say so once instead of reading the album and the user table
        // to reach a 403 every tick.
        if refused_memberships()
            .lock()
            .map(|mut seen| seen.insert(mapping.id.clone()))
            .unwrap_or(false)
        {
            let peer_name = peer_of(state, &mapping.peer)
                .map(|p| p.name)
                .unwrap_or_else(|| mapping.peer.clone());
            crate::log!(
                "\"{}\" is reunified — its members are the local owner's to change, so changes made at \"{peer_name}\" need the reunion re-run from the panel",
                mapping.album_name
            );
        }
        return;
    }
    let Some(album) = client
        .get(
            &format!("/albums/{}", mapping.album_id),
            &crate::immich::client::Auth::Key(&host_key),
        )
        .await
        .ok()
        .flatten()
    else {
        return; // album gone: the withdrawal path will clean up
    };
    // The humans of THIS household, from the admin's own view. Anything not in this list is one of our
    // utility accounts, and `diff_invitees` never removes one of those.
    let humans: Vec<Value> = client
        .get("/admin/users", &crate::immich::client::Auth::Admin)
        .await
        .ok()
        .flatten()
        .and_then(|users| users.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|u| !crate::config::is_utility_email(u.get("email").and_then(|e| e.as_str())))
        .collect();
    let current: Vec<String> = album
        .get("albumUsers")
        .and_then(|v| v.as_array())
        .map(|users| {
            users
                .iter()
                .filter(|au| au.get("role").and_then(|r| r.as_str()) != Some("owner"))
                .filter_map(|au| {
                    au.pointer("/user/id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let local: Vec<String> = humans
        .iter()
        .filter_map(|u| u.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let diff = diff_invitees(wanted, &current, &local);
    if !diff.add.is_empty() {
        // Same vanilla-parity rule as the mirror itself: the share's permission picks the role.
        let role = crate::sync::mirror::member_role(&mapping.permissions);
        let body = json!({
            "albumUsers": diff.add.iter().map(|id| json!({ "userId": id, "role": role })).collect::<Vec<_>>()
        });
        match client
            .json(
                reqwest::Method::PUT,
                &format!("/albums/{}/users", mapping.album_id),
                &crate::immich::client::Auth::Key(&host_key),
                Some(&body),
            )
            .await
        {
            Ok(_) => crate::log!(
                "invitation for \"{}\" now includes {} more of us",
                mapping.album_name,
                diff.add.len()
            ),
            Err(e) => crate::log!("could not widen mirror \"{}\": {e}", mapping.album_name),
        }
    }
    for id in &diff.remove {
        let name = humans
            .iter()
            .find(|u| u.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            .and_then(|u| u.get("name").and_then(|v| v.as_str()))
            .unwrap_or(id)
            .to_string();
        match client
            .json(
                reqwest::Method::DELETE,
                &format!("/albums/{}/user/{id}", mapping.album_id),
                &crate::immich::client::Auth::Key(&host_key),
                None,
            )
            .await
        {
            Ok(_) => crate::log!(
                "\"{name}\" was dropped from the invitation to \"{}\" — removed locally",
                mapping.album_name
            ),
            Err(e) => crate::log!("could not narrow mirror \"{}\": {e}", mapping.album_name),
        }
    }
}

/// Mirrors whose members we have already explained are the local owner's to change, so a reunified
/// album does not repeat the line every tick.
fn refused_memberships() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static REFUSED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    REFUSED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// One pull at a time, with a single queued follow-up.
///
/// A nudge is cheap to SEND and costs a sweep of every linked peer to answer, so an enrolled peer
/// could otherwise make this server run overlapping pulls just by asking repeatedly. Coalescing keeps
/// the guarantee the caller cares about — their change IS seen — while bounding what asking costs us.
static PULL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PULL_QUEUED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Pull now, because a peer said something changed.
///
/// NOT the invite lane's tick, and deliberately not gated by `sweeps_are_paused`: a nudge is the
/// PUSH half of the protocol, so a member learns about an invitation even while every sweep is held —
/// which is what the browser lane's no-reload case holds them to prove.
pub fn pull_invitations_soon(state: &std::sync::Arc<State>) {
    use std::sync::atomic::Ordering;
    // The flag is cleared by this guard however the task ends, so one failed pull can never wedge
    // the route into "coalesced" for ever — a state where the sidecar still answers a nudge with
    // `{ok:true}` and then never looks.
    let Some(_running) = crate::sync::sweeps::RunningFlagGuard::claim(&PULL_RUNNING) else {
        PULL_QUEUED.store(true, Ordering::SeqCst);
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        let _running = _running;
        let client = crate::immich::client::shared();
        loop {
            // Cleared BEFORE the pull, so a change that arrives mid-pull is seen as a follow-up
            // rather than dropped.
            PULL_QUEUED.store(false, Ordering::SeqCst);
            pull_invitations_once(&state, client).await;
            if !PULL_QUEUED.swap(false, Ordering::SeqCst) {
                break;
            }
        }
    });
}

/// The member side: mirror what a peer has invited us to, and drop what it has withdrawn.
pub async fn pull_invitations_once(state: &State, client: &Client) {
    let started = std::time::Instant::now();
    let peers: Vec<Peer> = state.collections().peers.clone();
    let mut changed = false;
    crate::log!("invitation pull: {} peer(s)", peers.len());
    for peer in peers {
        let peer_started = std::time::Instant::now();
        let Some(transport) = transport() else { return };
        let header = RequestHeader {
            path: "/invitations".into(),
            ..Default::default()
        };
        // Bounded: a peer that cannot answer must not hold the whole sweep, and an unreachable one
        // simply tries again next cycle.
        let Ok(Ok((head, body))) = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            transport.round_trip(&peer, &header, None),
        )
        .await
        else {
            continue;
        };
        // An old peer, or one sharing nothing with us. Not an error.
        if head.status >= 400 {
            continue;
        }
        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let invitations = parsed
            .get("invitations")
            .and_then(|i| i.as_array())
            .cloned()
            .unwrap_or_default();
        crate::log!(
            "invitation pull \"{}\": {} offered, {}ms to fetch",
            peer.name,
            invitations.len(),
            peer_started.elapsed().as_millis()
        );

        let mut offered: std::collections::HashSet<String> = std::collections::HashSet::new();
        for invitation in &invitations {
            let Some(album_id) = invitation
                .pointer("/album/id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
            else {
                continue;
            };
            offered.insert(album_id.clone());
            // Already mirrored, or we are the origin of this album ourselves.
            let known = state
                .collections()
                .mappings
                .iter()
                .find(|m| {
                    m.peer == peer.pub_key
                        && !m.dead
                        && (m.remote_album_id.as_deref() == Some(album_id.as_str())
                            || m.album_id == album_id)
                })
                .cloned();
            if let Some(known) = known {
                // The sender can add or drop individual people without withdrawing the album. Follow
                // it, or a de-invited person keeps the mirror forever and revocation silently does
                // nothing.
                //
                // Only for mirrors an INVITATION created. A link-redeemed mirror has its own
                // membership (whoever redeemed it, plus anyone who re-joined) and the invitation list
                // is not authoritative over it — narrowing one would evict people who joined by link.
                let for_user_ids: Vec<String> = invitation
                    .get("forUserIds")
                    .and_then(|v| v.as_array())
                    .map(|ids| {
                        ids.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                if known.role == Role::Member && known.via == "invite" {
                    sync_mirror_members(state, client, &known, &for_user_ids).await;
                }
                continue;
            }
            let album_name = invitation
                .pointer("/album/name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            // A mapping the watcher retired lingers DEAD while the origin still offers this share —
            // creating a fresh mirror beside it would leave a second mirror of one share, the state
            // a person cannot repair from the UI. Tear the stale one down first. `notify_origin:
            // false` because the origin withdrew NOTHING — it is offering the very share again.
            let stale: Option<String> = state
                .collections()
                .mappings
                .iter()
                .find(|m| dead_mirror_of_the_same_share(m, &peer.pub_key, &album_id))
                .map(|m| m.id.clone());
            if let Some(stale_id) = stale {
                match crate::sync::leave::leave_album(state, client, &stale_id, false).await {
                    Ok(_) => crate::log!(
                        "replaced the dead mirror of \"{album_name}\" before re-mirroring it"
                    ),
                    Err(e) => {
                        // Teardown failed: re-mirroring NOW would create the very second mirror
                        // this exists to prevent. The origin keeps offering the share, so the
                        // next pull retries the teardown and then the mirror.
                        crate::log!(
                            "could not remove the dead mirror of \"{album_name}\": {e} — deferring re-mirroring to the next pull"
                        );
                        continue;
                    }
                }
            }
            let permissions = invitation
                .get("permissions")
                .and_then(|v| v.as_str())
                .unwrap_or("view")
                .to_string();
            // Sharing is per person, so the origin always names who. NEVER fall back to "everyone
            // here": that would silently widen a share the sender deliberately narrowed.
            let for_user_ids: Vec<String> = invitation
                .get("forUserIds")
                .and_then(|v| v.as_array())
                .map(|ids| {
                    ids.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let request = crate::sync::mirror::MirrorRequest {
                peer: &peer,
                album_id: &album_id,
                album_name: &album_name,
                permissions: &permissions,
                album_owner_name: invitation
                    .pointer("/albumOwner/displayName")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                album_owner_id: invitation
                    .pointer("/albumOwner/originUserId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                remote_mapping_id: invitation
                    .get("mappingId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                for_user_ids: Some(for_user_ids.clone()),
                reunified: invitation
                    .get("reunified")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                via: "invite",
            };
            match crate::sync::mirror::ensure_mirror(state, client, &request).await {
                Ok(mirrored) => {
                    if mirrored.created {
                        changed = true;
                        crate::log!(
                            "\"{}\" invited {} of us to \"{}\" — mirrored it ({})",
                            peer.name,
                            for_user_ids.len(),
                            album_name,
                            permissions
                        );
                    }
                }
                Err(e) => crate::log!("could not mirror invitation \"{album_name}\": {e}"),
            }
        }

        // Withdrawn upstream: tear the mirror down rather than leaving a stale album of placeholders
        // that will never resolve. Reached only after a SUCCESSFUL poll — a failed one `continue`d.
        let withdrawn: Vec<(String, String)> = state
            .collections()
            .mappings
            .iter()
            .filter(|m| invitation_mirror_was_withdrawn(m, &peer.pub_key, &offered))
            .map(|m| (m.id.clone(), m.album_name.clone()))
            .collect();
        for (id, name) in withdrawn {
            // `notify_origin: true` — the origin withdrew, so it should retire its owner mapping.
            match crate::sync::leave::leave_album(state, client, &id, true).await {
                Ok(_) => {
                    changed = true;
                    crate::log!(
                        "\"{}\" withdrew \"{}\" — removed the mirror it created",
                        peer.name,
                        name
                    );
                }
                Err(e) => crate::log!("could not remove withdrawn mirror \"{name}\": {e}"),
            }
        }
    }
    // Told ONCE, at the end, and only when something actually moved: this is the pull that the
    // invite loop, the accept page and a peer's nudge all funnel through, so a panel hears about a
    // mirror whichever of them created it — and hears nothing when nothing changed.
    if changed {
        crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Invitations);
    }
    crate::log!(
        "invitation pull done: {} change(s), {}ms",
        if changed { 1 } else { 0 },
        started.elapsed().as_millis()
    );
}

/// A peer asking us to look at our invitations NOW.
pub fn handle_invitations_nudge(state: &std::sync::Arc<State>, caller_pub: &str) -> (u16, Value) {
    if peer_of(state, caller_pub).is_none() {
        return (403, json!({ "error": "unknown peer" }));
    }
    crate::sync::status::record_nudge(crate::sync::status::NudgeKind::Invitations);
    // A nudge is only worth sending if it makes the receiver LOOK, so the pull starts here rather
    // than at the next sweep: the household that just invited somebody is looking at a row that says
    // "waiting", and the invited person is looking at an open panel.
    crate::sync::invites::pull_invitations_soon(state);
    (200, json!({ "ok": true }))
}

/// What this household OFFERS the given peer: the invitations it has been given.
pub fn invitations_for(state: &State, peer_pub: &str) -> Vec<Value> {
    state
        .collections()
        .mappings
        .iter()
        // ONLY invitation-shaped shares. Offering link-redeemed ones here would re-mirror albums the
        // member already handled through join — and worse, silently undo a leave on the next poll,
        // because leaving removes the member's mapping but not the origin's.
        .filter(|m| m.role == Role::Owner && m.via == "invite" && m.peer == peer_pub && !m.dead)
        .map(|m| {
            let mut entry = json!({
                "mappingId": m.id,
                "album": { "id": m.album_id, "name": m.album_name },
                "permissions": m.permissions,
                "albumOwner": {
                    "displayName": m.album_owner_name,
                    "originUserId": m.album_owner_id,
                },
                "forUserIds": m.for_peer_user_ids.clone().unwrap_or_default(),
            });
            // Same ADDITIVE shape as the redeem answer: present only when it is a reunion, so an
            // ordinary invitation simply omits the key and "absent" keeps meaning "ordinary".
            if m.reunified == Some(true) {
                entry["reunified"] = json!(true);
            }
            entry
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_editor_contributes_and_everything_else_views() {
        assert_eq!(permission_for(Some("editor")), "contribute");
        assert_eq!(permission_for(Some("viewer")), "view");
        assert_eq!(
            permission_for(Some("owner")),
            "view",
            "an owner is not an invitation at all"
        );
        assert_eq!(
            permission_for(None),
            "view",
            "anything unrecognised is the safe role"
        );
    }

    #[test]
    fn two_markers_of_one_household_agree_on_contribute_whichever_was_read_first() {
        // Two markers of one household invited to the same album, one as editor and one as viewer,
        // name the SAME share: the household holds it at the more permissive of the two, so which
        // marker's answer arrived first must not decide what gets mirrored.
        assert_eq!(widest_permission("view", "contribute"), "contribute");
        assert_eq!(
            widest_permission("contribute", "view"),
            "contribute",
            "order must not decide"
        );
        assert_eq!(widest_permission("view", "view"), "view");
    }

    #[test]
    fn a_dead_member_mirror_of_the_same_share_is_replaced() {
        // A mapping the watcher retired lingers dead while the origin still offers the share; a
        // re-invite that finds it must tear it down rather than create a SECOND mirror of one share.
        let mut m = fixture_member_mirror("album-1");
        m.dead = true;
        assert!(dead_mirror_of_the_same_share(&m, "peer-a", "album-1"));
    }

    #[test]
    fn a_live_mirror_or_another_share_is_never_replaced() {
        let live = fixture_member_mirror("album-1");
        assert!(
            !dead_mirror_of_the_same_share(&live, "peer-a", "album-1"),
            "still in use"
        );
        let other_album = fixture_member_mirror("album-2");
        assert!(!dead_mirror_of_the_same_share(
            &other_album,
            "peer-a",
            "album-1"
        ));
        // An owner mapping to the same peer is this household's own share, never a mirror to replace.
        let mut owner = fixture_member_mirror("album-1");
        owner.dead = true;
        owner.role = Role::Owner;
        assert!(!dead_mirror_of_the_same_share(&owner, "peer-a", "album-1"));
        // ...and only the share's own peer's dead mirror counts.
        let mut other_peer = fixture_member_mirror("album-1");
        other_peer.dead = true;
        other_peer.peer = "peer-b".into();
        assert!(!dead_mirror_of_the_same_share(
            &other_peer,
            "peer-a",
            "album-1"
        ));
    }

    fn fixture_member_mirror(remote_album: &str) -> Mapping {
        Mapping {
            id: "m1".into(),
            role: Role::Member,
            album_id: "local-mirror".into(),
            album_name: "Holidays".into(),
            peer: "peer-a".into(),
            remote_album_id: Some(remote_album.into()),
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
