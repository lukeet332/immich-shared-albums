/** sync/engine.rs — the watcher: pushing what is new here out to peers. See PORT.md. */
use crate::immich::access::read_album_assets_as;
use crate::immich::client::Client;
use crate::immich::refs::{self, AssetRef};
use crate::p2p::entitlement::{record_offered, record_offered_refs};
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::{Mapping, Peer, Role};
use crate::sync::peer_mapping_id::peer_album_mapping_id;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

/// One frame would trip the receiver's `ISA_MAX_BODY_KB` on a large album — roughly 3k refs at the
/// default — and protocol 2 has no way to signal "split and resend". So we split.
const PUSH_BATCH: usize = 400;

/// The peer keeps saying it has no such album. Whatever happened over there — they unlinked us, lost
/// their state, left — retrying every cycle forever only fills the log. Retire it like a 410;
/// re-sharing the album starts a fresh mapping.
const PUSH_404_DEAD_AFTER: u32 = 20;

/// Consecutive failed pushes per mapping. In memory on purpose: a restart resetting the count costs
/// at most one extra cycle of retries, and it is not a fact worth a schema migration.
fn push_failures() -> &'static Mutex<HashMap<String, u32>> {
    static MAP: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The credential that reads this mapping's local album.
///
/// A member mirror is owned by the stand-in for the ORIGIN's album owner, so the admin key may not
/// be a member and Immich refuses it. An owner mapping IS this household's album, so the admin key
/// is the correct one there. Returning `None` for a member mapping with no host key is deliberate:
/// falling back to the admin key would reproduce the exact refusal this exists to avoid.

/// What a push achieved. `in_sync` is true when every ref landed, which is the WATCHER's cue to
/// store the version it read — not this function's, because a caller that has not read a version
/// must not record one.
pub struct PushOutcome {
    pub in_sync: bool,
}

/// Offer this mapping's album to its peer, and record what landed.
pub async fn push_album_refs(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
) -> Result<PushOutcome, String> {
    // OWNED first, then borrowed: `Auth::Key` borrows, and the old helper leaked a key per call to
    // hand out a `'static` one.
    let creds = crate::immich::access::MappingAuth::for_mapping(state, mapping)?;
    let auth = creds.auth();
    let Some(assets) = read_album_assets_as(client, &mapping.album_id, &auth).await else {
        return Err(format!(
            "no album.read access to \"{}\"",
            mapping.album_name
        ));
    };
    if let Some(live) = state
        .collections()
        .mappings
        .iter_mut()
        .find(|m| m.id == mapping.id)
    {
        live.fail_count = Some(0);
    }

    // REVOCATION, per photo: an asset removed from the album must stop being SERVED to this
    // mapping's peer, not merely stop being advertised. The revoked ids are ALSO the push's
    // removals: the origin's stub for a deleted contribution has no other way to learn its source
    // is gone (a push carries only adds unless we say otherwise).
    let current: Vec<String> = assets
        .iter()
        .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let revoked = state
        .store
        .offered_reconcile(&mapping.id, &current)
        .unwrap_or_default();
    if !revoked.is_empty() {
        crate::log!(
            "revoked {} byte entitlement(s) on \"{}\"",
            revoked.len(),
            mapping.album_name
        );
    }

    let users = crate::immich::client::users_by_id(client, 60_000).await;
    let ledger = crate::p2p::protocol::ledger_of_state();
    let (fresh, awaiting_shape) =
        refs::shareable_assets(state, &assets, &users, ledger, &mapping.id);

    // A photo held back for Immich's measurement is NOT "in sync": the watcher stores the album's
    // version cursor on an in-sync answer, and a stored cursor would skip this album until something
    // else changed it — which is how a held-back photo would never be offered again. A PENDING
    // REMOVAL is equally not in sync: the push below must still go out, with an empty `add`.
    if fresh.is_empty() && revoked.is_empty() {
        return Ok(PushOutcome {
            in_sync: awaiting_shape == 0,
        });
    }

    let target = peer_album_mapping_id(mapping);
    if target.is_empty() {
        crate::log!(
            "no remote album id for \"{}\" — nothing to push to",
            mapping.album_name
        );
        return Ok(PushOutcome { in_sync: false });
    }

    let add: Vec<AssetRef> = fresh
        .iter()
        .filter_map(|asset| refs::asset_to_ref(asset, &users, ledger))
        .collect();
    let mut remove = revoked;

    // OFFERING IS THE GRANT: the peer materialises DURING the push, fetching stub bytes back from
    // us before any response lands — so entitlement must be recorded FIRST.
    let offered_ids: Vec<String> = fresh
        .iter()
        .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    record_offered(state, &mapping.id, &offered_ids);

    let Some(transport) = transport() else {
        return Err("the peer transport is not running".to_string());
    };

    let mut failed: HashSet<String> = HashSet::new();
    let mut push_failed = false;
    let mut retire: Option<String> = None;

    // The removals ride the FIRST batch (an empty `add` is fine): the origin's stubs for them are
    // purged there, and every later batch is adds only. Idempotent — a removal for a row already
    // gone is a no-op, so a retry after a failed push cannot double-delete.
    const EMPTY_BATCH: [AssetRef; 0] = [];
    let mut batches: Vec<&[AssetRef]> = add.chunks(PUSH_BATCH).collect();
    if batches.is_empty() && !remove.is_empty() {
        batches.push(&EMPTY_BATCH);
    }
    for batch in &batches {
        let header = RequestHeader {
            path: format!("/albums/{target}/refs"),
            ..Default::default()
        };
        let mut body = serde_json::json!({ "add": batch });
        if !remove.is_empty() {
            body["remove"] = serde_json::json!(remove);
            remove = Vec::new();
        }
        let body = body.to_string();
        let (head, response) = match transport
            .round_trip(peer, &header, Some(body.as_bytes()))
            .await
        {
            Ok(v) => v,
            Err(e) => {
                crate::log!("ref push to \"{}\" failed: {e}", peer.name);
                push_failed = true;
                break;
            }
        };
        if head.status == 410 {
            retire = Some("peer answered 410 gone".to_string());
            push_failed = true;
            break;
        }
        if head.status >= 400 {
            push_failed = true;
            let mut counts = push_failures().lock().unwrap();
            let n = counts.entry(mapping.id.clone()).or_insert(0);
            *n += 1;
            if head.status == 404 && *n >= PUSH_404_DEAD_AFTER {
                retire = Some(format!(
                    "peer answered 404 to {n} pushes in a row — it no longer has this album"
                ));
                counts.remove(&mapping.id);
            } else if *n == 1 || *n % 10 == 0 {
                crate::log!(
                    "ref push to \"{}\" failed: {}{}",
                    peer.name,
                    head.status,
                    if *n > 1 {
                        format!(" (x{n})")
                    } else {
                        String::new()
                    }
                );
            }
            break;
        }
        // PARTIAL SUCCESS is the contract: the sender re-offers only the failed refs next cycle.
        if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&response) {
            if let Some(list) = parsed.get("failed").and_then(|f| f.as_array()) {
                for checksum in list.iter().filter_map(|c| c.as_str()) {
                    failed.insert(checksum.to_string());
                }
            }
        }
    }

    if let Some(reason) = retire {
        if let Some(live) = state
            .collections()
            .mappings
            .iter_mut()
            .find(|m| m.id == mapping.id)
        {
            live.dead = true;
            live.dead_at = Some(crate::config::iso_now());
            live.dead_reason = Some(reason.clone());
        }
        let _ = state.save();
        crate::log!(
            "\"{}\" no longer has \"{}\" ({reason}) — no longer pushing it",
            peer.name,
            mapping.album_name
        );
    }
    if push_failed {
        return Ok(PushOutcome { in_sync: false });
    }
    push_failures().lock().unwrap().remove(&mapping.id);

    let mut landed = 0usize;
    for reference in &fresh {
        let checksum = state.wire_checksum(
            reference
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            reference
                .get("checksum")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
        );
        if failed.contains(&checksum) {
            continue;
        }
        let asset_id = reference
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if state
            .store
            .seen_add(&mapping.id, &checksum, asset_id, None, false)
            .is_ok()
        {
            landed += 1;
        }
    }
    crate::log!(
        "pushed {}/{}{} to \"{}\"",
        landed,
        fresh.len(),
        if failed.is_empty() {
            String::new()
        } else {
            format!(" ({} deferred)", failed.len())
        },
        peer.name
    );

    Ok(PushOutcome {
        in_sync: failed.is_empty() && awaiting_shape == 0,
    })
}

/// Record a manifest's worth of refs as offered, for callers that advertise without pushing.
pub fn record_manifest_offered(state: &State, mapping_id: &str, manifest: &[AssetRef]) {
    record_offered_refs(state, mapping_id, manifest);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_stays_under_the_receivers_body_cap() {
        // 400 refs at ~1.5KB each is well under the default 1 MiB frame, and protocol 2 has no way
        // to signal "split and resend" — so the split has to happen here.
        assert_eq!(PUSH_BATCH, 400);
        assert!(
            PUSH_BATCH * 2048 < 1024 * 1024,
            "a full batch must fit an ISA_MAX_BODY_KB frame"
        );
    }

    #[test]
    fn a_404_is_tolerated_for_a_while_and_then_retires() {
        // A 404 is transient by protocol — the member's mirror may not exist yet. Twenty in a row
        // is not transient.
        assert_eq!(PUSH_404_DEAD_AFTER, 20);
        assert!(
            PUSH_404_DEAD_AFTER > 1,
            "one 404 must not retire a live share"
        );
    }

    fn users_of(rows: &[(&str, bool)]) -> crate::immich::client::USERS {
        rows.iter()
            .map(|(id, utility)| {
                (
                    id.to_string(),
                    crate::immich::client::UserInfo {
                        name: id.to_string(),
                        utility: *utility,
                    },
                )
            })
            .collect()
    }

    fn album_with_members(ids: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "albumUsers": ids.iter().map(|id| serde_json::json!({ "user": { "id": id } })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn a_stand_in_left_alone_is_not_a_native_leave() {
        // The stand-in IS the membership the sidecar created; counting it as a person would make
        // every mirror look occupied for ever, or (worse) freed the moment a human left and took the
        // stand-in's row with it.
        let album = album_with_members(&["stand-in"]);
        let users = users_of(&[("stand-in", true)]);
        assert_eq!(human_members(&album, &users), 0);
    }

    #[test]
    fn one_real_person_still_there_is_not_a_leave() {
        let album = album_with_members(&["stand-in", "human"]);
        let users = users_of(&[("stand-in", true), ("human", false)]);
        assert_eq!(human_members(&album, &users), 1);
    }

    #[test]
    fn an_unknown_member_id_never_makes_the_album_look_empty() {
        // The user map is a minute stale at worst, and a brand-new account is the one thing it can
        // miss. Acting on that would delete a mirror someone is still looking at — so only a KNOWN
        // member list may be read as "0 humans", which is what `member_list_is_known` gates.
        assert!(!member_list_is_known(&serde_json::json!({ "assetCount": 2 })));
        assert!(!member_list_is_known(&serde_json::json!({ "albumUsers": null })));
        assert!(member_list_is_known(&album_with_members(&[])));
    }
}

/// Per-mapping mutex: the join-time reconcile is fired unawaited and can race the interval loop —
/// both would materialise the same "missing" refs, and stubs are unique bytes, so Immich cannot
/// dedup the collision into one asset.
fn reconciling() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Heal member mirrors: re-pull the origin manifest and materialise anything we missed.
///
/// Deliberately a cheap no-op when in sync: the version handshake costs ONE row read at the origin,
/// and an unchanged version returns before the manifest is ever pulled.
pub async fn reconcile_once(state: &State, client: &Client) {
    let members: Vec<Mapping> = state
        .collections()
        .mappings
        .iter()
        .filter(|m| m.role == Role::Member && !m.dead)
        .cloned()
        .collect();
    for mapping in members {
        let Some(peer) = state
            .collections()
            .peers
            .iter()
            .find(|p| p.pub_key == mapping.peer)
            .cloned()
        else {
            continue;
        };
        if let Err(e) = reconcile_mapping(state, client, &mapping, &peer, false).await {
            crate::log!("reconcile error on \"{}\": {e}", mapping.album_name);
        }
    }
}

/// Bring one member mirror back in step with its origin. `remote_version` is stored only after a
/// CLEAN pass, so a failure keeps retrying rather than advancing a cursor past work not done.
pub async fn reconcile_mapping(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    force: bool,
) -> Result<(), String> {
    {
        let mut set = reconciling().lock().unwrap();
        if set.contains(&mapping.id) {
            return Ok(());
        }
        set.insert(mapping.id.clone());
    }
    let result = reconcile_inner(state, client, mapping, peer, force).await;
    reconciling().lock().unwrap().remove(&mapping.id);
    result
}

async fn reconcile_inner(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    force: bool,
) -> Result<(), String> {
    let target = mapping
        .remote_mapping_id
        .clone()
        .or_else(|| mapping.remote_album_id.clone())
        .unwrap_or_default();
    if target.is_empty() {
        return Err(format!("no remote album id for \"{}\"", mapping.album_name));
    }
    let Some(transport) = transport() else {
        return Err("the peer transport is not running".to_string());
    };

    // The handshake: ONE cheap read instead of a full manifest scan.
    let mut version: Option<String> = None;
    let mut expected_count: Option<usize> = None;
    let header = RequestHeader {
        path: format!("/albums/{target}/version"),
        ..Default::default()
    };
    match transport.round_trip(peer, &header, None).await {
        Ok((head, _)) if head.status == 410 => {
            // The origin says this relationship is over: tear our side down rather than retrying a
            // dead mapping forever with a mirror full of placeholders. `notify_origin` is false —
            // the origin is the one that ended it, and dialling it back to say so would be noise.
            crate::log!(
                "\"{}\" says \"{}\" has ended (410) — leaving the mirror",
                peer.name,
                mapping.album_name
            );
            match crate::sync::leave::leave_album(state, client, &mapping.id, false).await {
                Ok(_) => crate::log!("removed the mirror \"{}\" it ended", mapping.album_name),
                Err(e) => crate::log!(
                    "could not remove the ended mirror \"{}\": {e} — the loops will retry",
                    mapping.album_name
                ),
            }
            return Ok(());
        }
        Ok((head, body)) if head.status < 400 => {
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&body) {
                version = parsed
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                // The STRUCTURED field is preferred; the packed-string parse remains only for
                // protocol-2 peers that predate it.
                expected_count = parsed
                    .get("assetCount")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize)
                    .or_else(|| {
                        version
                            .as_deref()
                            .and_then(|v| v.split('|').nth(1))
                            .and_then(|n| n.parse::<usize>().ok())
                    });
            }
        }
        // The TypeScript swallows a failed handshake here, which makes "the peer could not be
        // reached" indistinguishable from "nothing changed". Say which it was.
        Ok((head, _)) => {
            crate::log!(
                "reconcile: version handshake for \"{}\" answered {} — retrying next cycle",
                mapping.album_name,
                head.status
            );
            return Ok(());
        }
        Err(e) => {
            crate::log!(
                "reconcile: could not reach \"{}\" for \"{}\" ({e}) — retrying next cycle",
                peer.name,
                mapping.album_name
            );
            return Ok(());
        }
    }

    // An unchanged version normally means nothing to do. With store-shared-locally on and stubs
    // still un-upgraded, the manifest is pulled anyway so the backfill can keep draining — switching
    // the setting on changes nothing at the origin, so the version would never move on its own.
    let backfill_pending = state.store_shared_assets_locally()
        && crate::sync::backfill::has_stub_rows(state, &mapping.id);
    // A FORCED pass (a nudge: "look again now") ignores an unchanged version — the thing that
    // changed may be invisible to the version token, a caption edit above all.
    if !force && version.is_some() && version == mapping.remote_version && !backfill_pending {
        return Ok(());
    }

    let header = RequestHeader {
        path: format!("/albums/{target}/manifest"),
        ..Default::default()
    };
    let Ok((head, body)) = transport.round_trip(peer, &header, None).await else {
        return Ok(());
    };
    if head.status >= 400 {
        return Ok(());
    }
    let manifest: Vec<AssetRef> = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| serde_json::from_value(v.get("manifest").cloned().unwrap_or_default()).ok())
        .unwrap_or_default();

    // The version's asset count comes from the album TABLE (instant); the manifest comes from the
    // search INDEX (which lags behind deletes). Only trust a read where the two AGREE — a dirty read
    // retries next cycle instead of poisoning the cursor.
    let consistent = expected_count.map(|n| manifest.len() == n).unwrap_or(true);

    // DELETION PROPAGATION: refs we materialised that the owner no longer offers are gone at the
    // source, so our stubs go too — guarded by `delete_proxy_asset`, which refuses anything not
    // owned by a utility account.
    let mut propagated = true;
    if version.is_some() && consistent {
        let offered: HashSet<&str> = manifest.iter().map(|r| r.checksum.as_str()).collect();
        for entry in state
            .store
            .seen_for_mapping(&mapping.id)
            .unwrap_or_default()
        {
            if entry.origin_asset.is_none() || offered.contains(entry.checksum.as_str()) {
                continue;
            }
            match crate::immich::materialise::delete_proxy_asset(state, client, &entry.local_asset)
                .await
            {
                Ok(crate::immich::materialise::PurgeOutcome::Purged)
                | Ok(crate::immich::materialise::PurgeOutcome::AlreadyGone) => {
                    let _ = state.store.seen_remove_entry(&mapping.id, &entry.checksum);
                    crate::log!(
                        "removed stub for a photo its owner deleted (\"{}\")",
                        mapping.album_name
                    );
                }
                // Not ours, or we could not tell: keep the cursor back so the removal retries next
                // cycle rather than being forgotten.
                Ok(crate::immich::materialise::PurgeOutcome::NotOurs) | Err(_) => {
                    propagated = false
                }
            }
        }
    }

    let missing: Vec<AssetRef> = manifest
        .iter()
        .filter(|r| {
            !state
                .store
                .seen_has(&mapping.id, &r.checksum)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let mut all_ok = true;
    for reference in &missing {
        match crate::immich::materialise::materialise_ref(state, client, mapping, peer, reference)
            .await
        {
            Ok(true) => crate::log!("reconciled missed ref into \"{}\"", mapping.album_name),
            Ok(false) => all_ok = false,
            Err(e) => {
                all_ok = false;
                crate::log!(
                    "reconcile materialise failed ({}): {e}",
                    &reference.checksum[..reference.checksum.len().min(10)]
                );
            }
        }
    }

    // DESCRIPTION REFRESH: an origin edit to a caption must reach the stubs that already exist —
    // materialise wrote the description once, and nothing else would ever tell a stub its source's
    // text changed. The version moved, so this pass is the moment to notice. The composition is
    // the one materialise wrote (the origin's text plus the credit line); the ORIGIN's text wins,
    // because a stub is a proxy for their photo, not a fork of it. Only stubs, never full copies:
    // a stored-FULL copy may hold the household's own edits and holds real bytes besides.
    if version.is_some() && consistent {
        let creds = crate::immich::access::MappingAuth::for_mapping(state, mapping)?;
        let stub_auth = creds.auth();
        for reference in &manifest {
            if missing.iter().any(|m| m.checksum == reference.checksum) {
                continue; // materialised this pass with the fresh description already
            }
            let Some(entry) = state
                .store
                .seen_for_checksum(&reference.checksum)
                .unwrap_or_default()
                .into_iter()
                .find(|e| e.mapping == mapping.id && !e.stored_full)
            else {
                continue;
            };
            let current = client
                .json(
                    reqwest::Method::GET,
                    &format!("/assets/{}", entry.local_asset),
                    &stub_auth,
                    None,
                )
                .await
                .ok()
                .flatten()
                .and_then(|a| {
                    a.pointer("/exifInfo/description")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            let wanted = crate::immich::client::composed_description(reference);
            if wanted == current {
                continue;
            }
            match client
                .json(
                    reqwest::Method::PUT,
                    &format!("/assets/{}", entry.local_asset),
                    &stub_auth,
                    Some(&serde_json::json!({ "description": wanted })),
                )
                .await
            {
                Ok(_) => crate::log!(
                    "refreshed a stub's description in \"{}\"",
                    mapping.album_name
                ),
                Err(e) => {
                    crate::log!(
                        "description refresh failed for {}: {e}",
                        &entry.local_asset[..8.min(entry.local_asset.len())]
                    );
                    all_ok = false; // the cursor must not advance past a refresh that did not land
                }
            }
        }
    }

    // Store-shared-locally: upgrade any stubs we still hold to full local copies, bounded per cycle.
    if state.store_shared_assets_locally() {
        crate::sync::backfill::backfill_full_copies(state, client, mapping, peer, &manifest).await;
    }

    if all_ok && propagated && version.is_some() && consistent {
        if let Some(live) = state
            .collections()
            .mappings
            .iter_mut()
            .find(|m| m.id == mapping.id)
        {
            live.remote_version = version;
        }
        let _ = state.save();
    }
    Ok(())
}

/// One pass of the watcher: push what is new here out to peers, then heal what we missed.
///
/// The tick is counted BEFORE anything can skip: this is "the watcher LOOKED", not "the watcher
/// worked". The rig waits on that count, so a cycle that skipped everything must still have looked.
pub async fn watch_once(state: &State, client: &Client) {
    crate::sync::status::record_loop_tick(crate::sync::status::LoopName::Watcher);

    // Snapshot the IDS, then re-look-up each mapping. The TypeScript iterates the live array, and a
    // `leaveAlbum` inside the loop splices it — so JS index-based iteration SKIPS the mapping after
    // a removal. Re-looking-up is strictly more correct: every live mapping is processed each cycle,
    // and a mapping retired mid-pass is skipped because it is looked up as dead.
    let ids: Vec<String> = state
        .collections()
        .mappings
        .iter()
        .map(|m| m.id.clone())
        .collect();
    for id in ids {
        let Some(mapping) = state
            .collections()
            .mappings
            .iter()
            .find(|m| m.id == id)
            .cloned()
        else {
            continue;
        };
        if mapping.dead {
            continue;
        }
        if let Err(e) = watch_mapping(state, client, &mapping).await {
            let failures = mapping.fail_count.unwrap_or(0) + 1;
            let access_error = e.contains("album.read access") || e.contains("Not found");
            let mut retired = false;
            if let Some(live) = state
                .collections()
                .mappings
                .iter_mut()
                .find(|m| m.id == mapping.id)
            {
                live.fail_count = Some(failures);
                if access_error && failures >= 5 {
                    live.dead = true;
                    live.dead_at = Some(crate::config::iso_now());
                    live.dead_reason = Some(format!(
                        "watcher: {}",
                        e.chars().take(120).collect::<String>()
                    ));
                    retired = true;
                }
            }
            if retired {
                let _ = state.save();
                crate::log!(
                    "mapping \"{}\" marked dead after {failures} failures (album deleted?) — no longer polled",
                    mapping.album_name
                );
            } else {
                crate::log!("watcher error on \"{}\": {e}", mapping.album_name);
            }
        }
    }
    reconcile_once(state, client).await;
}

/// Has the last human member left this mirror? A NATIVE leave — album settings -> Leave album in the
/// stock app — which is what the sidecar cleans up after: stubs, mirror, mapping. No custom UI.
///
/// MUST run before `watch_mapping`'s unchanged-album handshake. Immich bumps `album.updatedAt` on
/// album EDITS but NOT when a member leaves, so a pass that skips an "unchanged" album never sees the
/// last person walk out and the mirror, its stubs and the mapping stay for ever.
async fn last_human_left(client: &Client, album: &Value) -> bool {
    if !member_list_is_known(album) {
        return false;
    }
    let users = crate::immich::client::users_by_id(client, 60_000).await;
    human_members(album, &users) == 0
}

/// An album read that omits the member list is UNKNOWN, not empty: a partial read must never read as
/// "everyone left" and purge a mirror someone is still using.
fn member_list_is_known(album: &Value) -> bool {
    album.get("albumUsers").and_then(|u| u.as_array()).is_some()
}

/// How many of an album's members are PEOPLE. The stand-ins are OURS — an account this household
/// minted stands in for a remote person, so its membership says nothing about who is still here. An
/// id the user map does not know is not a person either: the map is a minute stale at worst, and
/// counting it as absent is only ever safe paired with a KNOWN member list.
fn human_members(album: &Value, users: &crate::immich::client::USERS) -> usize {
    album
        .get("albumUsers")
        .and_then(|u| u.as_array())
        .map(|list| {
            list.iter()
                .filter(|entry| {
                    entry
                        .pointer("/user/id")
                        .and_then(|v| v.as_str())
                        .and_then(|id| users.get(id))
                        .map(|u| !u.utility)
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

async fn watch_mapping(state: &State, client: &Client, mapping: &Mapping) -> Result<(), String> {
    // The local side is read with the credential that can actually see it: a member mirror is owned
    // by the ORIGIN owner's stand-in, not by this household's admin.
    let creds = crate::immich::access::MappingAuth::for_mapping(state, mapping)?;
    let auth = creds.auth();
    let Some(album) = crate::immich::access::read_album_as(client, &mapping.album_id, &auth).await
    else {
        return Err(format!(
            "no album.read access to \"{}\"",
            mapping.album_name
        ));
    };
    let updated_at = album
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // BEFORE the handshake below, deliberately: see `last_human_left`.
    if mapping.role == Role::Member && last_human_left(client, &album).await {
        crate::log!(
            "\"{}\" has no human member left — leaving the mirror natively",
            mapping.album_name
        );
        return match crate::sync::leave::leave_album(state, client, &mapping.id, true).await {
            Ok(outcome) => {
                crate::log!(
                    "left \"{}\" natively — {} stub(s) purged",
                    mapping.album_name,
                    outcome.purged
                );
                Ok(())
            }
            Err(e) => {
                crate::log!(
                    "native leave of \"{}\" failed: {e} — the loops will retry",
                    mapping.album_name
                );
                Ok(())
            }
        };
    }

    // HANDSHAKE: skip an untouched album entirely. `local_version` is stored only after a CLEAN
    // cycle, so deferred refs keep re-offering rather than being silently written off. One blind
    // spot: a member deleting their own CONTRIBUTION from their library removes it from the album
    // WITHOUT bumping `updatedAt` (Immich bumps on album edits, not on library deletes), so the
    // version alone never re-offers. The album's own asset count is the cheap tell — a mirror holds
    // origin stubs (ledger rows) plus this household's contributions (offered rows), so a count
    // that shrank below what we still account for means something left, and the push below
    // computes the real diff.
    let expected_assets = state
        .store
        .seen_for_mapping(&mapping.id)
        .map(|r| r.len())
        .unwrap_or(0)
        + state.store.offered_count(&mapping.id).unwrap_or(0);
    let album_count = album
        .get("assetCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    if let Some(updated_at) = updated_at.as_deref() {
        if mapping.local_version.as_deref() == Some(updated_at) && album_count >= expected_assets {
            return Ok(());
        }
    }

    if mapping.role == Role::Member {
        // View-only: nothing to push.
        if mapping.permissions == "view" {
            return Ok(());
        }
    }

    let Some(peer) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == mapping.peer)
        .cloned()
    else {
        return Ok(()); // no peer record: nothing to push to
    };

    let outcome = push_album_refs(state, client, mapping, &peer).await?;
    // The cursor is the WATCHER's handshake, so only the watcher moves it: a reunion pushes the same
    // way and has no business claiming the album was checked at a version it never read.
    if outcome.in_sync {
        if let Some(live) = state
            .collections()
            .mappings
            .iter_mut()
            .find(|m| m.id == mapping.id)
        {
            live.local_version = updated_at;
        }
        crate::sync::status::record_watcher_cycle(&mapping.id);
        let _ = state.save();
    }
    Ok(())
}

/// The watch loop: `ISA_SYNC_POLL_MS` between passes, guarded against overlapping itself.
pub fn start_watch_loop(state: Arc<crate::state::State>) {
    let period = std::time::Duration::from_millis(crate::config::cfg().sync_poll_ms);
    tokio::spawn(async move {
        let client = Client::new();
        loop {
            tokio::time::sleep(period).await;
            // Held by a rig proving a change was pushed, not swept. BEFORE the tick counter and the
            // overlap guard: a held loop did not look, and must not read as having looked.
            if crate::sync::sweeps::sweeps_are_paused() {
                continue;
            }
            if !crate::sync::sweeps::start_sweep("watch") {
                continue;
            }
            watch_once(&state, &client).await;
            crate::sync::sweeps::finish_sweep("watch");
        }
    });
}
