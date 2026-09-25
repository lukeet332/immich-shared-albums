/** sync/link_grants.rs — a link join lasts exactly as long as its link. See PORT.md. */
use crate::immich::client::{Auth, Client};
use crate::p2p::entitlement::forget_offered;
use crate::state::State;
use crate::store::Role;
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

/// How often an origin re-reads its own share links. Withdrawing a share is an admin action, not a
/// race, and the member's own teardown comes from a 410 handshake on ITS cadence — so this is a
/// poll, not a hot path. While no link grant is live it costs nothing at all: the read is skipped
/// before it is made, and the throttle below only applies once one exists.
const LINK_CHECK_INTERVAL_MS: i64 = 60_000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Does any link still point at this album? ABSENCE is the withdrawal.
///
/// Presence is the whole test, and deliberately so: a link row this code cannot fully read must not
/// revoke somebody's share. `expiresAt` is therefore NOT a withdrawal here — an expired link is a
/// limit on JOINING, and ending joins that already happened is a policy change with its own test to
/// write, not something to infer from an unparsed timestamp. See the note in PORT.md.
fn album_has_link(links: &[Value], album_id: &str) -> bool {
    links.iter().any(|l| {
        l.pointer("/album/id").and_then(|v| v.as_str()) == Some(album_id)
    })
}

/// One check per interval, whoever asks. Returns whether this call may do the read.
fn check_is_due() -> bool {
    static LAST: OnceLock<Mutex<i64>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(0));
    let mut last = last.lock().unwrap();
    let now = now_ms();
    if now.saturating_sub(*last) < LINK_CHECK_INTERVAL_MS {
        return false;
    }
    *last = now;
    true
}

/// Retire every link grant of ours whose link is gone.
///
/// The origin side of a withdrawal, and the owner's ONLY lever for a link join: the link is a bearer
/// grant, so nobody was named, nobody can be "removed", and until this existed a link share could
/// only be ended by unlinking the whole household. Retiring the mapping answers the member's next
/// `/version` with 410, which is the teardown it already knows how to do.
pub async fn retire_withdrawn_link_grants(state: &State, client: &Client) {
    // Cheap and usually empty: no link grant, no Immich read, no throttle.
    let governed: Vec<(String, String)> = state
        .collections()
        .mappings
        .iter()
        .filter(|m| m.role == Role::Owner && m.via == "link" && !m.dead)
        .map(|m| (m.id.clone(), m.album_id.clone()))
        .collect();
    if governed.is_empty() || !check_is_due() {
        return;
    }
    let Ok(Some(links)) = client.get("/shared-links", &Auth::Admin).await else {
        return;
    };
    let links = links.as_array().cloned().unwrap_or_default();
    for (mapping_id, album_id) in governed {
        if album_has_link(&links, &album_id) {
            continue;
        }
        retire_link_grant(state, client, &mapping_id).await;
    }
}

/// Reclaim what the join brought, then mark the mapping dead for good.
async fn retire_link_grant(state: &State, client: &Client, mapping_id: &str) {
    let album_name = state
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == mapping_id)
        .map(|m| m.album_name.clone())
        .unwrap_or_default();

    // The contributed photos this household holds on the departed member's behalf. Same guarded purge
    // a leave runs: only utility-owned assets, and only where the AUTHORITATIVE ledger row still
    // names this mapping, so a photo another share also claims is not deleted under it. A stored-FULL
    // copy is this household's own bytes and is kept — the leave rule, applied to a withdrawal.
    let mut reclaimed = 0usize;
    for entry in state
        .store
        .seen_for_mapping(mapping_id)
        .unwrap_or_default()
    {
        if entry.origin_asset.is_none() || entry.stored_full {
            continue;
        }
        let owner = state
            .store
            .ledger_by_asset(&entry.local_asset)
            .ok()
            .flatten();
        if owner.map(|o| o.mapping != mapping_id).unwrap_or(false) {
            continue;
        }
        match crate::immich::materialise::delete_proxy_asset(state, client, &entry.local_asset).await
        {
            Ok(crate::immich::materialise::PurgeOutcome::Purged) => reclaimed += 1,
            Ok(_) => {}
            Err(e) => crate::log!(
                "could not reclaim {} after a withdrawn share: {e}",
                entry.local_asset
            ),
        }
    }
    let _ = state.store.seen_forget_proxies(mapping_id);
    // Stop serving the bytes BEFORE the mapping is marked dead: entitlement is what the member reads
    // with, and a window where the grant is retired but the bytes are still offered is a window where
    // a withdrawn household can still pull originals.
    forget_offered(state, mapping_id);

    if let Some(mapping) = state
        .collections()
        .mappings
        .iter_mut()
        .find(|m| m.id == mapping_id)
    {
        mapping.dead = true;
        mapping.dead_at = Some(crate::config::iso_now());
        mapping.dead_reason = Some("share link withdrawn".to_string());
    }
    let _ = state.save();
    crate::log!(
        "link share withdrawn on \"{album_name}\" — retired the join and reclaimed {reclaimed} contributed photo(s)"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_link_for_another_album_does_not_keep_this_grant_alive() {
        // The rule is per ALBUM, not "some link exists somewhere": an origin usually has several
        // shares, and reading any of them as this one's grant would keep a withdrawn share alive
        // for ever.
        let links = vec![
            json!({ "key": "a", "album": { "id": "album-other" } }),
            json!({ "key": "b", "album": { "id": "album-here" } }),
        ];
        assert!(album_has_link(&links, "album-here"));
        assert!(!album_has_link(&links, "album-other-and-then-some"));
        let only_other = vec![json!({ "key": "a", "album": { "id": "album-other" } })];
        assert!(!album_has_link(&only_other, "album-here"));
    }

    #[test]
    fn no_links_at_all_is_the_withdrawal() {
        // The case the owner actually performs: delete the share link. An empty list must read as
        // withdrawn rather than as "no information", which is what makes the sweep safe to run.
        assert!(!album_has_link(&[], "album-here"));
    }

    #[test]
    fn a_link_row_with_no_album_is_not_a_grant_for_anything() {
        // Immich's own rows are not a contract we get to assume: a row missing `album.id` must not
        // match every album in the loop, or one malformed link would keep every share alive.
        let links = vec![json!({ "key": "a" }), json!({ "album": {} }), json!({ "album": { "id": 7 } })];
        assert!(!album_has_link(&links, "album-here"));
    }
}
