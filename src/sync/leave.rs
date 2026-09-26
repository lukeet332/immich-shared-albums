/** sync/leave.rs — undoing a join. See ARCHITECTURE.md. */
use crate::immich::client::Client;
use crate::p2p::entitlement::forget_offered;
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::Role;
use crate::sync::album_teardown::{album_teardown, TeardownMapping};
use crate::sync::peer_mapping_id::{peer_of, remote_target};

/// Leave and purge: the reverse of joining.
///
/// Removes every stub this album materialised (utility-owner-guarded), the mirror album, the mapping
/// and its ledger — a join is FULLY REVERSIBLE and reclaims all the space it ever took, except for
/// an asset another mapping still claims.
///
/// An ADOPTED mapping is the exception, and `album_teardown` decides it: that album existed before
/// the share and holds a person's OWN photos, so leaving gives up the mapping and nothing else. A
/// mistaken reunification therefore costs exactly the stubs.
pub struct LeaveOutcome {
    pub left: String,
    pub purged: usize,
    /// Stubs left in place because they belong to an account we hold no key for.
    pub refused: usize,
    /// Stubs we could not even decide about — the caller must not read this as reclaimed space.
    pub failed: usize,
}

/// `notify_origin: false` is for un-reunifying, which undoes the ADOPTION but not the SHARE: the
/// person goes back to an ordinary mirror, and the invitation they still hold re-creates it through
/// the normal invite path. Telling the origin "we left" would retire its owner mapping and the share
/// would be GONE rather than mirrored.
pub async fn leave_album(
    state: &State,
    client: &Client,
    mapping_id: &str,
    notify_origin: bool,
) -> Result<LeaveOutcome, crate::web::route_error::RouteError> {
    use crate::web::route_error::RouteError;
    let Some(mapping) = state
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == mapping_id)
        .cloned()
    else {
        return Err(RouteError::bad_input(
            "unknown mapping (only joined albums can be left)",
        ));
    };
    if mapping.role != Role::Member {
        return Err(RouteError::bad_input(
            "unknown mapping (only joined albums can be left)",
        ));
    }
    let plan = album_teardown(TeardownMapping::from(&mapping));

    let mut purged = 0usize;
    let mut refused = 0usize;
    let mut failed = 0usize;
    let mut kept = 0usize;
    let mut unpurged: std::collections::HashSet<String> = std::collections::HashSet::new();
    let entries = state
        .store
        .seen_for_mapping(&mapping.id)
        .unwrap_or_default();
    for entry in &entries {
        if entry.origin_asset.is_none() {
            continue;
        }
        // A STORED-FULL copy is the household's own real bytes, paid for when store-shared-locally
        // was switched on. Leaving the album withdraws the SHARE, not the library — the copy stays.
        if entry.stored_full {
            kept += 1;
            continue;
        }
        // A deduped proxy can carry ledger rows from several mappings, so another mapping may still
        // be serving this very asset. Ask the AUTHORITATIVE row (the one holding the true wire
        // identity) rather than whether any row mentions the id — a stale row must never pin a
        // stored copy that nothing else claims.
        let owner = state
            .store
            .ledger_by_asset(&entry.local_asset)
            .ok()
            .flatten();
        if owner.map(|o| o.mapping != mapping.id).unwrap_or(false) {
            continue;
        }
        match crate::immich::materialise::delete_proxy_asset(state, client, &entry.local_asset)
            .await
        {
            Ok(crate::immich::materialise::PurgeOutcome::Purged) => purged += 1,
            // Absent to every credential we hold is the outcome the caller wanted, but it is not
            // evidence of a deletion and must not be counted as one.
            Ok(crate::immich::materialise::PurgeOutcome::AlreadyGone) => {}
            Ok(crate::immich::materialise::PurgeOutcome::NotOurs) => {
                refused += 1;
                unpurged.insert(entry.checksum.clone());
            }
            Err(e) => {
                crate::log!("could not purge {}: {e}", entry.local_asset);
                failed += 1;
                unpurged.insert(entry.checksum.clone());
            }
        }
    }

    if plan.delete_album {
        // The local side is deleted with the credential that can see it — a member mirror is owned by
        // the origin owner's stand-in, not by this household's admin. A member mapping with no key is
        // REFUSED rather than deleted as the household (`MappingAuth::for_mapping`).
        let creds = crate::immich::access::MappingAuth::for_mapping(state, &mapping)
            .map_err(|e| RouteError::unavailable(e.to_string()))?;
        let auth = creds.auth();
        if let Err(e) = client
            .json(
                reqwest::Method::DELETE,
                &format!("/albums/{}", mapping.album_id),
                &auth,
                None,
            )
            .await
        {
            crate::log!("mirror album delete failed: {e}");
        }
    } else {
        crate::log!("kept \"{}\" — {}", mapping.album_name, plan.reason);
    }

    crate::sync::status::forget_watcher_cycles(&mapping.id);
    // Forget only the rows whose purge SETTLED (or whose asset another mapping still serves, or
    // which never had an origin at all). A row whose stub could NOT be deleted is the only record
    // that the stub exists — forgetting it would orphan the stub in Immich for ever, unreachable by
    // any later reclaim — so it is kept and the failure is logged instead.
    if unpurged.is_empty() {
        let _ = state.store.seen_forget_proxies(&mapping.id);
    } else {
        for entry in &entries {
            if unpurged.contains(&entry.checksum) || entry.stored_full {
                continue;
            }
            let _ = state.store.seen_remove_entry(&mapping.id, &entry.checksum);
        }
        crate::log!(
            "left {} stub ledger row(s) of \"{}\" un-purged — kept so a retry can reclaim them",
            unpurged.len(),
            mapping.album_name
        );
    }
    let _ = state.store.seen_act_remove_mapping(&mapping.id);
    forget_offered(state, &mapping.id);
    // SPLICE, never reassign. Loops run concurrently (watch, comments, invites), and replacing the
    // array silently discards anything another loop pushed onto the old reference in the meantime —
    // which lost freshly-created mirrors until this was found.
    state.collections().mappings.retain(|m| m.id != mapping.id);
    let _ = state.save();

    // Courtesy signal so the origin stops pushing to a household that left. Best-effort and
    // unawaited: leaving must NEVER block on the origin being reachable, and a peer too old to know
    // the route just 404s.
    let origin = peer_of(state, &mapping.peer);
    let target = remote_target(&mapping);
    if notify_origin {
        if let (Some(origin), Some(target), Some(transport)) = (origin, target, transport()) {
            let transport = transport.clone();
            let header = RequestHeader {
                path: format!("/albums/{target}/leave"),
                ..Default::default()
            };
            // Fire-and-forget, on purpose: the leaving side owes the origin a courtesy, not a wait.
            tokio::spawn(async move {
                let _ = transport.round_trip(&origin, &header, None).await;
            });
        }
    }
    crate::log!(
        "left \"{}\" — {purged} stub(s) purged, {refused} refused, {failed} failed",
        mapping.album_name
    );
    if kept > 0 {
        crate::log!(
            "kept {kept} stored local cop(ies) in \"{}\" — the leave withdraws the share, not the library",
            mapping.album_name
        );
    }
    Ok(LeaveOutcome {
        left: mapping.album_name,
        purged,
        refused,
        failed,
    })
}
