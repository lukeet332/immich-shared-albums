/** sync/album_index.rs — publishing a person's owned albums so a linked peer can match them. See PORT.md. */
use crate::immich::access::{read_caller_albums, Creds};
use crate::immich::client::Client;
use crate::state::State;
use crate::store::{Direction, Mapping, OwnedAlbum, Peer};
use serde_json::{json, Value};

/// How long a panel visit waits for a peer's index before answering from the one it has.
///
/// Opening the panel is a person waiting, and a peer behind a relay that has to be re-dialled costs
/// seconds — the transport's own dial deadline, every time. Matching is a pull, so an index a visit
/// or two stale is the ordinary case; a blank section for ten seconds is not.
pub const INDEX_REFRESH_DEADLINE_MS: u64 = 2500;

/// One album as the index holds it: what a peer needs to match against, and WHO OWNS IT HERE.
///
/// The owner is the field the repair flow routes by, so an album without one cannot be offered —
/// skipping it is what keeps a guess out of the index.
fn owned_album_from(album: &Value, caller_user_id: &str) -> Option<OwnedAlbum> {
    // A malformed album is SKIPPED, not thrown over: this runs against what a peer produced, and
    // the sidecar fails open.
    let members = album.get("albumUsers").and_then(|m| m.as_array())?;
    // An album response carries no `ownerId` — Immich says who owns it inside `albumUsers`.
    let owner = members.iter().find(|entry| {
        entry.get("role").and_then(|r| r.as_str()) == Some("owner")
            && entry.pointer("/user/id").and_then(|v| v.as_str()).is_some()
    })?;
    let owner_id = owner.pointer("/user/id").and_then(|v| v.as_str()).unwrap_or_default();
    // The caller must be the OWNER, as IMMICH says. Anything else is an album they can merely see,
    // and offering it would publish someone else's library to a linked server.
    if owner_id != caller_user_id {
        return None;
    }
    Some(OwnedAlbum {
        name: album.get("albumName").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        asset_count: album.get("assetCount").and_then(|v| v.as_i64()).unwrap_or(0),
        start_date: album.get("startDate").and_then(|v| v.as_str()).map(str::to_string),
        end_date: album.get("endDate").and_then(|v| v.as_str()).map(str::to_string),
        owner_name: owner
            .pointer("/user/name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        owner_user_id: Some(caller_user_id.to_string()),
    })
}

/// Immich's own album list as an owned index. Unknown entries are DROPPED rather than guessed at,
/// because a guess here offers someone's library to a linked server.
pub fn albums_i_publish(albums: &[Value], caller_user_id: &str) -> Vec<OwnedAlbum> {
    if caller_user_id.is_empty() {
        return Vec::new();
    }
    albums.iter().filter_map(|a| owned_album_from(a, caller_user_id)).collect()
}

/// Read the caller's OWN albums from Immich and record them for one peer.
///
/// On the caller's forwarded credential, and that is the point: ownership is answered by the server
/// that owns the albums, so nothing a client posts can add an album the caller does not own or omit
/// one they do. Returns `None` when the read was refused, which is not the same as owning nothing.
pub async fn publish_owned_albums(
    state: &State,
    client: &Client,
    creds: &Creds,
    caller_user_id: &str,
    peer: &str,
) -> Option<Vec<OwnedAlbum>> {
    let albums = albums_i_publish(&read_caller_albums(client, creds).await?, caller_user_id);
    offer_albums_to(state, &albums, caller_user_id, peer);
    Some(albums)
}

/// Record what this person offers a peer, from a list already in hand.
///
/// Separate from the read above because a panel ALREADY reads the caller's albums to compute its
/// matches: offering them is the same fact, and re-reading Immich for it would be a round trip for
/// nothing.
pub fn offer_albums_to(
    state: &State,
    albums: &[OwnedAlbum],
    caller_user_id: &str,
    peer_pub: &str,
) {
    let _ = state.store.published_albums_set(
        peer_pub,
        Direction::ToThem,
        caller_user_id,
        albums,
    );
}

/// What this server OFFERS the given peer — the index its `/albums` route answers with.
pub fn published_albums_for(state: &State, peer: &str) -> Vec<OwnedAlbum> {
    state.store.published_albums_for(peer, Direction::ToThem).unwrap_or_default()
}

/// Refresh what a peer offers us, from that peer's own `/albums`.
///
/// Pull-only, like invitations, so a household behind CGNAT still matches perfectly well. A peer too
/// old to know the route answers 404, which is "peer too old" rather than an error, so the cached
/// index simply stands. Best-effort throughout: a failure keeps the last good snapshot rather than
/// clearing an index the panel is about to read.
pub async fn refresh_peer_albums(state: &State, peer: &Peer) -> Vec<OwnedAlbum> {
    let keep = || state.store.published_albums_for(&peer.pub_key, Direction::FromThem).unwrap_or_default();
    let Some(transport) = crate::p2p::transport::transport() else { return keep() };
    let header = crate::p2p::frame::RequestHeader { path: "/albums".into(), ..Default::default() };
    let exchange = transport.round_trip(peer, &header, None);
    let Ok(Ok((head, body))) =
        tokio::time::timeout(std::time::Duration::from_millis(INDEX_REFRESH_DEADLINE_MS), exchange)
            .await
    else {
        return keep();
    };
    if head.status >= 400 {
        return keep();
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(list) = parsed.get("albums").and_then(|a| a.as_array()) else {
        return keep();
    };
    let incoming: Vec<OwnedAlbum> = list
        .iter()
        .filter_map(|a| serde_json::from_value::<OwnedAlbum>(a.clone()).ok())
        .collect();

    // REPLACE the peer's whole index rather than one owner at a time. This answer IS the whole
    // index, so an owner missing from it has withdrawn everything and must stop being matched
    // against — which a per-owner write cannot express, because it is only ever called FOR an owner
    // the answer still mentions.
    let before = keep();
    if state.store.published_albums_replace_peer(&peer.pub_key, Direction::FromThem, &incoming).is_err() {
        return before;
    }
    let after = keep();
    // Only on a real change: a panel's own match read lands here, and an unconditional hint would
    // tell the page that asked to ask again, forever, never landing a fresh answer.
    if before != after {
        crate::log!("album index from \"{}\" changed ({} album(s))", peer.name, after.len());
        crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Index);
    }
    after
}

/// The panel's Invite: share the caller's OWN album with the person on the peer who owns the other
/// half.
///
/// The same act Immich's own picker performs — ONE membership, for ONE account, on the caller's own
/// album, on the caller's own credential — done from the panel so a person does not have to leave it.
/// It grants nothing wider: the account is a viewer of one album, and the caller asked for it by
/// clicking.
///
/// The person is addressed by their id on THEIR server, and ONLY if the peer's own published index
/// names them for an album of that name. A request cannot invent a person to share with, and the
/// album is re-derived from the caller's own Immich list rather than taken from the body.
pub async fn invite_peer_to_reunite(
    state: &State,
    client: &Client,
    creds: &Creds,
    caller_user_id: &str,
    peer: &Peer,
    album_name: &str,
    owner_user_id: &str,
) -> Result<(String, String), String> {
    // What the peer published, read NOW. A panel's rows come from the index the loop keeps, which
    // may not have pulled this peer since they published — and an invitation is an explicit act, so
    // it may wait briefly for the truth where a page load must not.
    refresh_peer_albums(state, peer).await;
    let wanted = crate::sync::matches::normalise_album_name(album_name);
    let theirs = state
        .store
        .published_albums_for(&peer.pub_key, Direction::FromThem)
        .unwrap_or_default()
        .into_iter()
        .find(|a| {
            a.owner_user_id.as_deref() == Some(owner_user_id)
                && crate::sync::matches::normalise_album_name(&a.name) == wanted
        })
        .ok_or_else(|| {
            "that pairing is not in this server's index — open the panel again and retry".to_string()
        })?;

    let caller_albums = read_caller_albums(client, creds)
        .await
        .ok_or_else(|| "could not read your albums".to_string())?;
    let mine = crate::sync::adoption::find_adoptable_album(album_name, &caller_albums, caller_user_id)
        .ok_or_else(|| format!("you have no album called \"{album_name}\""))?;

    // THE MEMBERSHIP IS THE INVITATION, so it is added the way a human's would be and the ordinary
    // scanner turns it into one — the same path, the same mapping, the same everything. Two things
    // make that work: `invitation` keeps it out of the attribution ledger, and `home_peer` is set
    // because the peer's own published index named this person as that album's owner THERE, which is
    // the same proof a directory exchange gives.
    let person = crate::immich::contributors::ensure_contributor(
        state,
        client,
        theirs.owner_name.as_str(),
        &mine.album_id,
        &crate::immich::client::Auth::Creds(creds),
        theirs.owner_user_id.as_deref(),
        Some(&peer.pub_key),
        true,
        true,
    )
    .await?;

    // READ IT BACK rather than trust the call. `ensure_contributor` deliberately swallows a failed
    // add — attribution can retry — but a panel that says "Invited" for someone who is not on the
    // album is a lie the person cannot see through, and the peer is never told either.
    let after = client.get_album(&mine.album_id, &crate::immich::client::Auth::Creds(creds)).await;
    let is_member = after
        .ok()
        .flatten()
        .and_then(|album| {
            album.get("albumUsers").and_then(|u| u.as_array()).map(|users| {
                users.iter().any(|au| {
                    au.pointer("/user/id").and_then(|v| v.as_str())
                        == person.user_id.as_deref()
                })
            })
        })
        .unwrap_or(false);
    if !is_member {
        return Err(format!(
            "could not share \"{}\" with {} — nothing was changed",
            mine.name, theirs.owner_name
        ));
    }

    // Run the scanner NOW rather than on its next tick: the mapping it records is what turns the row
    // into "waiting" and tells the peer, and the person is looking at that row.
    let _ = crate::sync::invites::detect_invites_once(state, client).await;

    // The trail, in the album's own comments — the same channel the reunion uses, so the album
    // narrates its own history. The bot has to BE a member to speak, and only an album's owner can
    // make it one: this request is that moment.
    let mapping = state
        .collections()
        .mappings
        .iter()
        .find(|m| {
            m.role == crate::store::Role::Owner
                && m.peer == peer.pub_key
                && m.album_id == mine.album_id
                && !m.dead
        })
        .cloned();
    // No mapping means the peer is never told, and the inviter's row would sit on "Invite" for ever
    // after a success notice. That IS a failure, and it has to read as one.
    let Some(mapping) = mapping else {
        return Err(format!(
            "\"{}\" is shared with {}, but the invitation was not recorded — open the panel again",
            mine.name, theirs.owner_name
        ));
    };
    if let Err(e) =
        crate::sync::house_bot::add_house_bot_to_album(state, client, &mine.album_id, creds).await
    {
        crate::log!("could not put the bot on \"{}\" to record the invite: {e}", mine.name);
    }
    crate::sync::audit::audit_line(
        state,
        client,
        &mapping.id,
        &mine.album_id,
        "invited",
        &format!(
            "Invited {} to reunite this album — the two merge into this one when they accept.",
            theirs.owner_name
        ),
    )
    .await;
    Ok((mine.name, theirs.owner_name))
}

/// Everything the panel needs to render its "possible reunions" section.
///
/// The caller's own albums come from Immich on THEIR credential — the same read the publish path
/// makes, for the same reason — and each linked peer's index is refreshed first, so a peer that has
/// published since the last visit is seen now. A panel is visited rarely, so this spends one request
/// per peer when it is opened rather than on every sync tick.
pub async fn my_matches(
    state: &State,
    client: &Client,
    creds: &Creds,
    caller_user_id: &str,
) -> Option<Vec<serde_json::Value>> {
    let albums = read_caller_albums(client, creds).await?;
    let mine = crate::sync::matches::albums_i_publish_from(&albums, caller_user_id);
    // OFFER what this person owns, here and now, and offer even when the list is EMPTY: a panel
    // visit is the only moment the sidecar holds their credential, so it is the only moment an
    // offer can be made. An offer of NOTHING is still an offer — it is how a peer learns that every
    // album this person had is gone — so this runs BEFORE the empty check, not inside the loop.
    let peers: Vec<Peer> = state.collections().peers.clone();
    for peer in &peers {
        offer_albums_to(state, &mine, caller_user_id, &peer.pub_key);
    }
    if mine.is_empty() {
        return Some(Vec::new());
    }

    let mappings: Vec<Mapping> = state.collections().mappings.clone();
    let mut out = Vec::new();
    for peer in &peers {
        // Bounded inside: a person opening their own panel must not wait out a peer's dial.
        let theirs = refresh_peer_albums(state, peer).await;
        for candidate in
            crate::sync::matches::matches_with_peer(&mine, &theirs, &peer.pub_key, &peer.name)
        {
            let share = crate::sync::matches::share_for(
                &mappings,
                &peer.pub_key,
                &candidate.candidate.mine.name,
                candidate.candidate.theirs.owner_user_id.as_deref(),
            );
            let step = crate::sync::matches::reunion_step_for(share.as_ref());
            // A pairing that was already reunited is not a candidate: it belongs to the reunified
            // albums, with its way out. Leaving it here offered a reunion that had already happened,
            // and the row never went away.
            if step == crate::sync::matches::ReunionStep::Reunited {
                continue;
            }
            out.push(match_entry(&candidate, &step));
        }
    }
    Some(out)
}

/// One row of the panel's "possible reunions" list.
///
/// `mappingId` is TOP-LEVEL and not only inside `step`: the panel's Reunite button reads the row's
/// own `mappingId`, so a step that says `accept` without one is a button that does nothing.
fn match_entry(candidate: &crate::sync::matches::PeerMatch, step: &crate::sync::matches::ReunionStep) -> Value {
    let mut entry = serde_json::to_value(candidate).unwrap_or(Value::Null);
    if let Some(object) = entry.as_object_mut() {
        if let crate::sync::matches::ReunionStep::Accept { mapping_id } = step {
            object.insert("mappingId".into(), json!(mapping_id));
        }
        object.insert("step".into(), serde_json::to_value(step).unwrap_or_default());
    }
    entry
}

/// Refresh what every linked peer offers us, bounded and best-effort.
///
/// The index is a PULL like every other cross-server fact, so it belongs on the loop rather than on
/// a page: a panel that dials cannot be faster than the slowest peer it is linked to.
pub async fn refresh_peer_indexes(state: &State) -> usize {
    let peers: Vec<Peer> = state.collections().peers.clone();
    let mut refreshed = 0usize;
    for peer in peers {
        let before = state
            .store
            .published_albums_for(&peer.pub_key, Direction::FromThem)
            .map(|a| a.len())
            .unwrap_or(0);
        let after = refresh_peer_albums(state, &peer).await;
        if after.len() != before || !after.is_empty() {
            refreshed += 1;
        }
    }
    refreshed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn album(id: &str, owner_role: &str, owner_id: &str) -> Value {
        json!({
            "id": id,
            "albumName": format!("album {id}"),
            "assetCount": 3,
            "albumUsers": [{ "role": owner_role, "user": { "id": owner_id, "name": "Someone" } }],
        })
    }

    #[test]
    fn only_albums_the_caller_OWNS_are_offered() {
        // The unsafe direction: offering an album the caller can merely SEE publishes someone
        // else's library to a linked server.
        let albums = vec![
            album("a", "owner", "me"),
            album("b", "editor", "me"),
            album("c", "owner", "someone-else"),
            album("d", "viewer", "me"),
        ];
        let published = albums_i_publish(&albums, "me");
        assert_eq!(published.len(), 1, "only the owned one");
        assert_eq!(published[0].name, "album a");
        assert_eq!(published[0].owner_user_id.as_deref(), Some("me"));
    }

    #[test]
    fn an_album_with_no_owner_entry_is_skipped_rather_than_guessed_at() {
        let no_owner = json!({ "id": "x", "albumName": "x", "albumUsers": [] });
        assert!(albums_i_publish(&[no_owner], "me").is_empty());
        // A malformed list is skipped, never thrown over: this runs against a peer's output.
        let broken = json!({ "id": "y", "albumUsers": "not-an-array" });
        assert!(albums_i_publish(&[broken], "me").is_empty());
    }

    #[test]
    fn an_unknown_caller_offers_nothing() {
        assert!(albums_i_publish(&[album("a", "owner", "me")], "").is_empty());
    }

    #[test]
    fn the_owner_name_travels_with_the_album() {
        // The repair flow routes owner-to-owner, so an index entry without a name cannot be acted on.
        let published = albums_i_publish(&[album("a", "owner", "me")], "me");
        assert_eq!(published[0].owner_name, "Someone");
        assert_eq!(published[0].asset_count, 3);
    }

    #[test]
    fn an_accept_row_carries_a_top_level_mapping_id() {
        // The panel's Reunite button reads the ROW's `mappingId`, not the step's: a step that says
        // accept without one is a button that does nothing, which is how the accept case silently
        // stopped working while every status code stayed 200.
        let candidate = crate::sync::matches::PeerMatch {
            candidate: crate::sync::matches::AlbumCandidate {
                mine: crate::store::OwnedAlbum {
                    name: "Holidays".into(),
                    asset_count: 2,
                    start_date: None,
                    end_date: None,
                    owner_name: "Demo Nan".into(),
                    owner_user_id: Some("me".into()),
                },
                theirs: crate::store::OwnedAlbum {
                    name: "Holidays".into(),
                    asset_count: 3,
                    start_date: None,
                    end_date: None,
                    owner_name: "Grandpa Joe".into(),
                    owner_user_id: Some("them".into()),
                },
                same_dates: false,
                why: "same album name".into(),
            },
            peer: "peer".into(),
            peer_name: "Their household".into(),
        };
        let accept = crate::sync::matches::ReunionStep::Accept { mapping_id: "m-1".into() };
        let row = match_entry(&candidate, &accept);
        assert_eq!(row["mappingId"], "m-1", "the button reads this");
        assert_eq!(row["step"]["kind"], "accept");
        assert_eq!(row["step"]["mappingId"], "m-1");
        assert_eq!(row["mine"]["name"], "Holidays");
        assert_eq!(row["peerName"], "Their household");

        // A waiting row offers no action, so it must carry no mappingId for a button to pick up.
        let waiting = match_entry(&candidate, &crate::sync::matches::ReunionStep::Waiting);
        assert!(waiting.get("mappingId").is_none());
        assert_eq!(waiting["step"]["kind"], "waiting");
    }
}
