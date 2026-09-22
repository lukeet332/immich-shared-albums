/** sync/mirror.rs — creating the local mirror of a remote album. See PORT.md. */
use crate::config::{bot_prefix, cfg, is_utility_email, UTILITY_EMAIL_DOMAIN};
use crate::immich::client::{Auth, Client};
use crate::immich::access::Creds;
use crate::immich::contributors::{ensure_utility_user, ContributorSpec};
use crate::state::State;
use crate::store::{Mapping, Peer, Role};
use serde_json::{json, Value};

/// What a mirror is asked to become. Only the facts the origin supplied.
pub struct MirrorRequest<'a> {
    pub peer: &'a Peer,
    pub album_id: &'a str,
    pub album_name: &'a str,
    /// `contribute` or `view`. Mapped to Immich's own vocabulary, never stored as-is.
    pub permissions: &'a str,
    /// The album owner's display name on the origin; falls back to the household name.
    pub album_owner_name: Option<String>,
    /// The owner's id on THEIR server — required, and the key this account is filed under.
    pub album_owner_id: Option<String>,
    /// The origin's own mapping id, when the join carried one.
    pub remote_mapping_id: Option<String>,
    /// Restrict the mirror to these local users. Absent adds every human, which is what a link
    /// join does: a link is redeemed by someone, for the household.
    pub for_user_ids: Option<Vec<String>>,
    /// The origin says this share is part of a reunion. Recorded, never inferred.
    pub reunified: bool,
    /// How this share was acquired: `link` for a redeemed share link, `invite` for one a human made
    /// in Immich's own picker. It scopes member-side withdrawal — only invitation-created mirrors may
    /// be torn down when an invitation stops being offered, because a link-redeemed mirror has its
    /// own lifecycle and retiring it here would silently unshare every link-based album.
    pub via: &'a str,
}

pub struct Mirrored {
    pub mapping: Mapping,
    pub created: bool,
}

/// An existing live mirror of this share, if there is one. Re-joining finds it rather than making a
/// second album: two mirrors of one share is the state a person cannot repair from the UI.
fn existing_mirror(state: &State, peer_pub: &str, remote_album_id: &str) -> Option<Mapping> {
    state
        .collections()
        .mappings
        .iter()
        .find(|m| {
            m.role == Role::Member
                && m.peer == peer_pub
                && m.remote_album_id.as_deref() == Some(remote_album_id)
                && !m.dead
        })
        .cloned()
}

/// Immich's own vocabulary for a share's permission. A view-only share makes local people VIEWERS,
/// exactly as Immich's own no-upload links do: an editor role on a view-only mirror lets them add
/// photos that silently go nowhere, because a view-only mirror never pushes.
fn member_role(permissions: &str) -> &'static str {
    if permissions == "contribute" {
        "editor"
    } else {
        "viewer"
    }
}

/// The album name this household shows. `{name}` and `{peer}` are the only substitutions, and they
/// are the operator's template, not ours to extend.
fn mirror_album_name(album_name: &str, peer_name: &str) -> String {
    cfg()
        .mirror_album_template
        .replace("{name}", album_name)
        .replace("{peer}", peer_name)
}

/// Add the local humans to a mirror, with the role the share's permission maps to.
///
/// Every local account that is not one of our own stand-ins, unless `for_user_ids` names people —
/// a per-person invitation is for those people, not the household. Already-present members are
/// skipped rather than re-added, because Immich answers 200 for an existing membership and a
/// re-add is therefore invisible either way.
async fn add_local_members(
    client: &Client,
    album_id: &str,
    host_key: &str,
    role: &str,
    for_user_ids: Option<&Vec<String>>,
) -> Result<usize, String> {
    // The HOUSEHOLD key, not the stand-in's: listing every account needs `adminUser.read`, and a
    // stand-in's key is deliberately scoped to the actions it performs — it answers 403 here.
    let users = client
        .get("/admin/users", &Auth::Admin)
        .await
        .map_err(|e| e.message())?
        .unwrap_or(Value::Null);
    let listed = users.as_array().cloned().unwrap_or_default();
    let mut wanted: Vec<String> = listed
        .iter()
        .filter(|u| {
            !is_utility_email(u.get("email").and_then(|e| e.as_str()))
        })
        .filter_map(|u| u.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    if let Some(only) = for_user_ids {
        wanted.retain(|id| only.contains(id));
    }

    // Who is already in it, read with the OWNER's key — reads are scoped per credential, so the
    // admin key would answer about the admin's own albums instead.
    let album = client
        .get(&format!("/albums/{album_id}"), &Auth::Key(host_key))
        .await
        .map_err(|e| e.message())?
        .unwrap_or(Value::Null);
    let already: Vec<String> = album
        .get("albumUsers")
        .and_then(|a| a.as_array())
        .map(|users| {
            users
                .iter()
                .filter_map(|u| u.get("user").and_then(|x| x.get("id")).and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    wanted.retain(|id| !already.contains(id));
    if wanted.is_empty() {
        return Ok(0);
    }
    let members: Vec<Value> =
        wanted.iter().map(|id| json!({ "userId": id, "role": role })).collect();
    client
        .json(
            reqwest::Method::PUT,
            &format!("/albums/{album_id}/users"),
            &Auth::Key(host_key),
            Some(&json!({ "albumUsers": members })),
        )
        .await
        .map_err(|e| e.message())?;
    Ok(members.len())
}

/// The checksums the peer already holds for this share — what an adoption must NOT offer back.
///
/// Reunification exists to give each side the UNION, so an adopted album's photos have to be offered
/// to the peer: the ones only this side holds are exactly the half the merge is for. What must not be
/// offered is a photo the peer ALREADY has, because the receiving side can only suppress a duplicate
/// it can see in its own ledger — and a peer's own human-owned photo leaves no ledger row, so offering
/// it materialises a stub beside the original.
///
/// Best effort, and deliberately fails CLOSED: a peer that cannot be reached answers `None`, and the
/// caller then seeds nothing. That costs the merge in one direction, which a later reunion repairs;
/// guessing the other way duplicates photos in someone's album, which nothing repairs on its own.
pub async fn peer_held_checksums(
    peer: &Peer,
    remote_id: Option<&str>,
) -> Option<std::collections::HashSet<String>> {
    let remote_id = remote_id.filter(|id| !id.is_empty())?;
    let transport = crate::p2p::transport::transport()?;
    let header = crate::p2p::frame::RequestHeader {
        path: format!("/albums/{remote_id}/manifest"),
        ..Default::default()
    };
    let (head, body) = transport.round_trip(peer, &header, None).await.ok()?;
    if head.status != 200 {
        return None;
    }
    let parsed: Value = serde_json::from_slice(&body).ok()?;
    let manifest = parsed.get("manifest")?.as_array()?;
    Some(
        manifest
            .iter()
            .filter_map(|r| r.get("checksum").and_then(|c| c.as_str()))
            .filter(|c| !c.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Remove what the OLD mirror held, now that the mapping points at the adopted album.
///
/// Its stubs are ours and the ledger says so, so removal is a deletion rather than a decision.
/// Entries whose AUTHORITATIVE row belongs to another mapping are left alone: a deduped proxy can
/// carry rows from several mappings, and this one is not the owner.
///
/// `mirror` is the mapping as it was BEFORE the move — its `album_id` and `host_slug` are the album
/// being retired, which is the only reason the caller must not pass the moved one.
async fn retire_mirror(state: &State, client: &Client, mirror: &Mapping) -> usize {
    let mut removed = 0usize;
    for entry in state.store.seen_for_mapping(&mirror.id).unwrap_or_default() {
        if entry.origin_asset.is_none() {
            continue;
        }
        let owner = state.store.ledger_by_asset(&entry.local_asset).ok().flatten();
        if owner.map(|o| o.mapping != mirror.id).unwrap_or(true) {
            continue;
        }
        // FORGET THE ROW FIRST, then delete the stub. reconcile skips any ref the ledger already
        // knows, so a row left behind by a delete that failed would keep that photo from ever being
        // materialised into the album the mapping now points at — and every retry is skipped for the
        // same reason. Here the share MOVED rather than ended, so forgetting the row is what lets
        // reconcile put the photo where the mapping now looks.
        let _ = state.store.seen_remove_entry(&mirror.id, &entry.checksum);
        use crate::immich::materialise::PurgeOutcome;
        match crate::immich::materialise::delete_proxy_asset(state, client, &entry.local_asset).await {
            // Gone already is the outcome the caller wanted: absent to every credential we hold.
            Ok(PurgeOutcome::Purged) | Ok(PurgeOutcome::AlreadyGone) => removed += 1,
            Ok(PurgeOutcome::NotOurs) | Err(_) => {
                crate::log!("could not remove the replaced copy of one photo — the loops will retry");
            }
        }
    }
    // `adopted` is None, which is what the TypeScript passes: the album being retired is the share's
    // mirror, so it is deleted when we still hold the key that owns it.
    let plan = crate::sync::album_teardown::album_teardown(
        crate::sync::album_teardown::TeardownMapping {
            role: Role::Member,
            adopted: None,
            album_name: &mirror.album_name,
        },
    );
    let host_key = mirror
        .host_slug
        .as_ref()
        .and_then(|slug| state.collections().contributors.get(slug).and_then(|c| c.api_key.clone()));
    if plan.delete_album {
        if let Some(key) = host_key {
            if let Err(e) = client
                .json(reqwest::Method::DELETE, &format!("/albums/{}", mirror.album_id), &Auth::Key(&key), None)
                .await
            {
                crate::log!("could not remove the replaced mirror: {e}");
            }
        }
    }
    if removed > 0 {
        crate::log!("reclaimed {removed} stub(s) from the replaced mirror");
    }
    removed
}

/// Tell the origin its share is now part of a reunion here.
///
/// A fact, not a command: it records what happened and asks for nothing back. It is what clears the
/// pairing from the inviter's "possible reunions" list, and a page already open is told the same way
/// it is told everything else.
pub async fn tell_origin_reunited(mapping: &Mapping, peer: &Peer) {
    let Some(remote_id) = mapping
        .remote_mapping_id
        .clone()
        .or_else(|| mapping.remote_album_id.clone())
        .filter(|id| !id.is_empty())
    else {
        return;
    };
    let Some(transport) = crate::p2p::transport::transport() else { return };
    let header = crate::p2p::frame::RequestHeader {
        path: format!("/albums/{remote_id}/reunified"),
        ..Default::default()
    };
    // Bounded and best effort: the reunion has already succeeded locally, and a peer that is down
    // must not turn a completed act into a failure.
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(3_000),
        transport.round_trip(peer, &header, None),
    )
    .await;
}

/// Replace a share's mirror with an album the person already owns — the panel's Reunite.
///
/// Distinct from adopting at acquisition time: the share already exists, so this MOVES a mapping
/// rather than creating one. Ordering is the whole of it:
///
/// 1. prove the requested album is theirs and is the album this share is about;
/// 2. let the house bot in, so the album can be read at all;
/// 3. seed the ledger from the album being adopted, WHILE the mapping still points at the mirror —
///    so no loop can read a ledger that does not yet describe the album it will point at;
/// 4. move the mapping and mark it;
/// 5. only then remove what the mirror held.
///
/// A failure after step 4 costs the mirror's stubs, which are ours and re-materialise; a failure
/// before it changes nothing.
pub async fn unify_own_album(
    state: &std::sync::Arc<State>,
    client: &Client,
    mapping: &Mapping,
    requested_album_name: &str,
    owner_creds: &Creds,
    owner_user_id: &str,
) -> Result<(String, usize), String> {
    // BOUND FIRST, in its own statement. As an argument, the `collections()` temporary would live
    // until the end of the statement — which includes the `.await` — holding the state lock across
    // a suspension point. The compiler refuses it (the future stops being `Send`); at runtime it
    // would be a deadlock of exactly the kind this port has hit three times.
    let peer = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == mapping.peer)
        .cloned()
        .ok_or("the share names a server that is not linked")?;
    let held = peer_held_checksums(
        &peer,
        mapping.remote_mapping_id.as_deref().or(mapping.remote_album_id.as_deref()),
    )
    .await;

    let caller_albums = crate::immich::access::read_caller_albums(client, owner_creds)
        .await
        .ok_or("could not read your albums")?;
    let own = crate::sync::adoption::can_unify_own_album(
        &mapping.album_id,
        &mapping.album_name,
        requested_album_name,
        &caller_albums,
        owner_user_id,
    )
    .ok_or_else(|| format!("\"{}\" cannot be reunited with that album", mapping.album_name))?;

    // 2. The sidecar reads the album as the house bot, so the bot must be a member first — added on
    //    the owner's own credential, from their own request: the membership is their act.
    crate::sync::house_bot::add_house_bot_to_album(state, client, &own.album_id, owner_creds).await?;
    let house_bot_key = state
        .collections()
        .contributors
        .get(&crate::sync::house_bot::house_bot_slug())
        .and_then(|c| c.api_key.clone())
        .ok_or("house bot has no key after provisioning — cannot read the album")?;
    let assets = crate::immich::access::read_album_assets_as(
        client,
        &own.album_id,
        &crate::immich::client::Auth::Key(&house_bot_key),
    )
    .await
    .unwrap_or_default();

    // 3. Seeded BEFORE the move, so the mapping is never visible with a ledger that describes a
    //    different album.
    let seeded = seed_adopted_album(state, &mapping.id, &assets, held.as_ref());

    // 4. Move it.
    {
        let mut collections = state.collections();
        if let Some(live) = collections.mappings.iter_mut().find(|m| m.id == mapping.id) {
            live.album_id = own.album_id.clone();
            live.album_name = own.name.clone();
            live.host_slug = Some(crate::sync::house_bot::house_bot_slug());
            live.adopted = Some(true);
            // ADOPTING IS REUNIFYING, so this records the ACT rather than echoing what the origin
            // claimed. The panel lists reunified albums by this field.
            live.reunified = Some(true);
        }
    }
    state.save().map_err(|e| e.to_string())?;
    crate::log!(
        "reunited \"{}\" — {} photo(s) were already here; {seeded} the peer already holds, {} to offer them{}",
        own.name,
        assets.len(),
        assets.len().saturating_sub(seeded),
        if held.is_some() { "" } else { " (the peer could not be asked what it holds, so none is offered)" }
    );

    // 5. Only now remove what the mirror held.
    retire_mirror(state, client, &mapping).await;
    // RE-SEED, and it has to be after the retire: `seen_add` ignores a row the mirror already wrote,
    // so in the co-owned case this feature exists for — the peer and the owner both hold the photo —
    // the owner's own asset got no row, and `retire_mirror` has just dropped the mirror's. Without
    // this pass the checksum is claimed by nobody, `seen_has` is false, and the next reconcile
    // materialises a stub right beside the person's own photo.
    seed_adopted_album(state, &mapping.id, &assets, held.as_ref());

    // The trail, left once the move is done and the bot is a member — the grant above is the only
    // moment an album belonging to a human can gain it.
    let peer_name = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == mapping.peer)
        .map(|p| p.name.clone());
    crate::sync::audit::audit_line(
        state,
        client,
        &mapping.id,
        &own.album_id,
        "reunited",
        &format!(
            "Reunited with \"{}\" — photos both sides hold now show once. Undo any time from your shared-albums page.",
            peer_name.as_deref().unwrap_or("a linked server")
        ),
    )
    .await;

    let peer = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == mapping.peer)
        .cloned();
    if let Some(peer) = peer {
        // Same grant as acquisition-time adoption, and for the same reason: the contributor accounts
        // that will own this album's stubs can only be given a membership by its owner, who is
        // present here and nowhere else. A peer that cannot be reached now grants nothing and must
        // not fail the reunion — `peer_contributors` returns empty instead.
        let contributors = crate::sync::album_grant::peer_contributors(
            &peer,
            mapping.remote_mapping_id.as_deref().or(mapping.remote_album_id.as_deref()),
        )
        .await;
        crate::sync::album_grant::grant_album_writers(
            state,
            client,
            &own.album_id,
            owner_creds,
            &peer,
            &contributors,
        )
        .await;
        crate::sync::album_grant::grant_invited_humans(
            client,
            &own.album_id,
            owner_creds,
            &mapping.for_peer_user_ids.clone().unwrap_or_default(),
            if mapping.permissions == "contribute" { "editor" } else { "viewer" },
        )
        .await;
        {
            let mut collections = state.collections();
            if let Some(live) = collections.mappings.iter_mut().find(|m| m.id == mapping.id) {
                // Clearing the cursor first makes the pull do work: `reconcile_mapping` returns early
                // when the origin's version is unchanged, and moving an album changes nothing there.
                live.remote_version = None;
            }
        }
        let _ = state.save();
        // BOUND FIRST, in its own statement: an `if let` scrutinee temporary lives for the whole
        // body, so the `collections()` guard would be held across the `.await` below.
        let live = state.collections().mappings.iter().find(|m| m.id == mapping.id).cloned();
        if let Some(live) = live {
            tell_origin_reunited(&live, &peer).await;
            // Deliberately not awaited: a reconcile and a push can both be slow, and the person is
            // looking at a panel that has already been told the reunion landed.
            let owned_state = state.clone();
            let peer_for_tasks = peer.clone();
            let mapping_for_tasks = live.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::sync::engine::reconcile_mapping(
                    &owned_state,
                    crate::immich::client::shared(),
                    &mapping_for_tasks,
                    &peer_for_tasks,
                )
                .await
                {
                    crate::log!(
                        "post-reunion reconcile for \"{}\": {e} — the loops will retry",
                        mapping_for_tasks.album_name
                    );
                }
            });
            // The OTHER direction, and the one only this side can start: the peer's album is
            // completed by OUR half arriving, and it cannot pull what it does not know we hold — its
            // only route to these photos is this push.
            let owned_state = state.clone();
            let peer_for_tasks = peer.clone();
            let mapping_for_tasks = live.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::sync::engine::push_album_refs(
                    &owned_state,
                    crate::immich::client::shared(),
                    &mapping_for_tasks,
                    &peer_for_tasks,
                )
                .await
                {
                    crate::log!(
                        "post-reunion push for \"{}\": {e} — the loops will retry",
                        mapping_for_tasks.album_name
                    );
                }
            });
        }
    }
    Ok((own.name, assets.len()))
}

/// Write the ledger rows for an album being adopted, and say how many there were.
///
/// Only the photos the peer already holds are seeded: the rest are this side's half of the split
/// album, and offering them to the peer IS the merge.
fn seed_adopted_album(
    state: &State,
    mapping_id: &str,
    assets: &[Value],
    peer_holds: Option<&std::collections::HashSet<String>>,
) -> usize {
    let rows = crate::sync::matches::seed_rows_for_adoption(assets, peer_holds);
    for row in &rows {
        let _ = state.store.seen_add(mapping_id, &row.checksum, &row.local_asset, None, false);
    }
    rows.len()
}

/// Create the local mirror of a remote album, or return the one that already exists.
///
/// Idempotent by design: re-joining adds the requested person to the existing mirror and returns it
/// with `created: false`, rather than making a second album of the same name.
pub async fn ensure_mirror(
    state: &State,
    client: &Client,
    req: &MirrorRequest<'_>,
) -> Result<Mirrored, String> {
    let owner_name = req
        .album_owner_name
        .clone()
        .unwrap_or_else(|| req.peer.name.clone());
    // Required, not defaulted. The account this creates and the one a directory would create must
    // be the same human; keying on a name would make two people share an account, or one person
    // appear twice in a picker.
    let Some(owner_id) = req.album_owner_id.as_deref().filter(|id| !id.is_empty()) else {
        return Err(format!(
            "the origin did not identify the owner of \"{}\" — cannot mirror it",
            req.album_name
        ));
    };
    // `homePeer` is deliberately NOT set: a redeem proves the person's ID, never where they live.
    // Only a directory does that.
    let spec = ContributorSpec {
        display_name: owner_name,
        full_name: None,
        state_key: format!("{}{owner_id}", bot_prefix::PERSON),
        email: format!("{}{owner_id}@{UTILITY_EMAIL_DOMAIN}", bot_prefix::PERSON),
        via_peer: Some(req.peer.pub_key.clone()),
        peer_user_id: Some(owner_id.to_string()),
        home_peer: None,
        permissions: None,
    };
    let host = ensure_utility_user(state, client, &spec).await?;
    let host_key = host.api_key.clone().ok_or("the stand-in has no key after provisioning")?;
    // Their own face, if their server offers one — best effort, and it stops retrying once it lands.
    crate::immich::contributors::sync_avatar(
        state,
        client,
        &host,
        Some(req.peer),
        req.album_owner_id.as_deref(),
    )
    .await;

    let role = member_role(req.permissions);

    if let Some(existing) = existing_mirror(state, &req.peer.pub_key, req.album_id) {
        let added = add_local_members(
            client,
            &existing.album_id,
            &host_key,
            role,
            req.for_user_ids.as_ref(),
        )
        .await
        .unwrap_or(0);
        if added > 0 {
            crate::log!("added {added} member(s) to existing mirror \"{}\"", existing.album_name);
        }
        return Ok(Mirrored { mapping: existing, created: false });
    }

    // Created BY THE STAND-IN, so the stand-in owns what is filed into it — creating it as the
    // admin and then adding the stand-in yields `no albumAsset.create access`, silently.
    //
    // Retried, because this is the first write of a join and Immich answers 500 for a moment after
    // its own migrations on a fresh instance. Six attempts, backing off, then give up loudly.
    let mut created = None;
    let mut last_error = String::new();
    for attempt in 1..=6u32 {
        match client
            .post(
                "/albums",
                &Auth::Key(&host_key),
                &json!({ "albumName": mirror_album_name(req.album_name, &req.peer.name) }),
            )
            .await
        {
            Ok(album) => {
                created = album
                    .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string));
                if created.is_some() {
                    break;
                }
                last_error = "Immich answered without an album id".to_string();
            }
            Err(e) => last_error = e.message(),
        }
        crate::log!("mirror album create attempt {attempt} failed: {last_error}");
        if attempt < 6 {
            tokio::time::sleep(std::time::Duration::from_millis(u64::from(attempt) * 2000)).await;
        }
    }
    let Some(album_id) = created else {
        return Err(format!("could not create the mirror album: {last_error}"));
    };

    // A failure to add members is NOT fatal: the mirror exists and the reconciler will fill it, and
    // the person can be added again on the next join. Failing here would throw away a created album.
    match add_local_members(client, &album_id, &host_key, role, req.for_user_ids.as_ref()).await {
        Ok(n) => {
            let scope = match &req.for_user_ids {
                Some(ids) => format!("{} named user(s)", ids.len()),
                None => format!("{n} household member(s)"),
            };
            crate::log!("mirror shared with {scope}");
        }
        Err(e) => crate::log!("could not add local members to mirror: {e}"),
    }

    let mapping = Mapping {
        id: new_uuid(),
        role: Role::Member,
        album_id,
        album_name: mirror_album_name(req.album_name, &req.peer.name),
        peer: req.peer.pub_key.clone(),
        remote_album_id: Some(req.album_id.to_string()),
        remote_mapping_id: req.remote_mapping_id.clone(),
        permissions: req.permissions.to_string(),
        host_slug: Some(spec.state_key),
        via: req.via.to_string(),
        for_peer_user_ids: req.for_user_ids.clone(),
        album_owner_name: req.album_owner_name.clone(),
        album_owner_id: req.album_owner_id.clone(),
        adopted: None,
        reunified: if req.reunified { Some(true) } else { None },
        dead: false,
        dead_at: None,
        dead_reason: None,
        fail_count: None,
        local_version: None,
        remote_version: None,
        comment_count: None,
        remote_comment_count: None,
    };
    state.collections().mappings.push(mapping.clone());
    state.save().map_err(|e| format!("could not record the mirror: {e}"))?;
    Ok(Mirrored { mapping, created: true })
}

/// A v4-shaped random id, matching what the TypeScript's `crypto.randomUUID()` writes — the schema
/// stores it as an opaque string, but a reader comparing the two builds should not see two shapes.
pub fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_share_makes_viewers_and_a_contribute_share_editors() {
        // The unsafe direction is `editor` on a view-only mirror: those photos are accepted by
        // Immich and then never pushed, so a person believes they contributed and they did not.
        assert_eq!(member_role("view"), "viewer");
        assert_eq!(member_role("contribute"), "editor");
        assert_eq!(member_role(""), "viewer", "anything unrecognised is the safe role");
        assert_eq!(member_role("admin"), "viewer");
    }

    #[test]
    fn a_mirror_id_is_uuid_shaped_like_the_typescript_writes() {
        let id = new_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(id.matches('-').count(), 4);
        assert_eq!(id.as_bytes()[14], b'4', "version 4");
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'), "variant bits");
        assert_ne!(id, new_uuid());
    }
}
