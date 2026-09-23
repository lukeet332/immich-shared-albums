/** p2p/protocol.rs — the inbound peer handlers. See PORT.md. */
use crate::config::{cfg, SIDECAR_VERSION};
use crate::immich::access::read_album_assets_as;
use crate::immich::client::{get_shared_link_by_key, owner_name, Client};
use crate::immich::refs::{self, Ledger};
use crate::protocol::PROTOCOL_VERSION;
use crate::settings::Settings;
use crate::state::state;
use crate::state::State;
use crate::store::{Mapping, Role};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

/// Compare two secrets without leaking their length or content through timing.
///
/// The length check is not an early return: on a mismatch it still performs one comparison of equal
/// length, so the work done does not reveal which branch was taken. Passwords here guard an album,
/// and a compare that returns early turns a share link into an oracle.
pub fn secret_equals(expected: &str, candidate: &str) -> bool {
    let a = expected.as_bytes();
    let b = candidate.as_bytes();
    if a.len() != b.len() {
        let _ = a.ct_eq(a);
        return false;
    }
    a.ct_eq(b).into()
}

/// The ledger lookups `refs` needs, wired to this process's store.
pub fn ledger_of_state() -> Ledger<'static> {
    // The closures borrow the process-wide store, which lives for the program's lifetime.
    Ledger {
        wire_checksum: &|id: &str, local: &str| state().wire_checksum(id, local),
        has_ledger_row: &|id: &str| state().store.ledger_by_asset(id).ok().flatten().is_some(),
    }
}

/// A share link is being redeemed: a peer is joining an album of ours.
///
/// The connection already proved possession of the caller's key, so the enrolled identity IS
/// `caller_pub` — the payload only names the household. Nothing to verify, nothing to forge.
pub async fn handle_redeem(caller_pub: &str, body: &[u8]) -> (u16, Value) {
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        return (400, json!({ "error": "malformed request" }));
    };
    let household_name = parsed
        .pointer("/household/name")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .to_string();
    if household_name.is_empty() {
        return (400, json!({ "error": "malformed household" }));
    }
    if let Some(their_protocol) = parsed.get("protocol").and_then(|p| p.as_i64()) {
        if their_protocol > PROTOCOL_VERSION as i64 {
            crate::log!(
                "peer \"{household_name}\" speaks protocol {their_protocol} > ours ({PROTOCOL_VERSION}) — update this server's sidecar"
            );
        }
    }
    let share_key = parsed
        .get("shareKey")
        .and_then(|k| k.as_str())
        .unwrap_or_default()
        .to_string();
    let version = parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let password = parsed.get("password").and_then(|p| p.as_str());

    let client = Client::new();
    let Some(link) = get_shared_link_by_key(&client, &share_key).await else {
        return (
            404,
            json!({ "error": "unknown share key", "code": "unknown_share_key" }),
        );
    };
    if link.get("type").and_then(|t| t.as_str()) != Some("ALBUM") {
        return (
            404,
            json!({ "error": "unknown share key", "code": "unknown_share_key" }),
        );
    }

    // A share link's OWN rules are the owner's stated intent, honoured here exactly as Immich's
    // share page honours them — the key is not the whole credential.
    if let Some(expires_at) = link.get("expiresAt").and_then(|e| e.as_str()) {
        if let Ok(expiry) = chrono_parse_ms(expires_at) {
            if expiry <= now_ms() {
                crate::log!("redeem refused: share link expired ({expires_at})");
                return (
                    403,
                    json!({ "error": "this share link has expired", "code": "link_expired" }),
                );
            }
        }
    }

    match link.get("password").and_then(|p| p.as_str()) {
        Some(expected) if !expected.is_empty() => match password {
            None => {
                return (
                    401,
                    json!({
                        "error": "this album is password protected",
                        "code": "password_required",
                        "passwordRequired": true,
                    }),
                )
            }
            Some(given) if !secret_equals(expected, given) => {
                crate::log!("redeem refused: wrong album password from \"{household_name}\"");
                return (
                    403,
                    json!({ "error": "incorrect album password", "code": "wrong_password" }),
                );
            }
            _ => {}
        },
        // No password on the link. ISA_LINK_JOIN_REQUIRES_PASSWORD is a gate on JOINING, not on
        // viewing, so it refuses here rather than at the share page.
        _ if cfg().link_join_requires_password => {
            crate::log!("redeem refused: ISA_LINK_JOIN_REQUIRES_PASSWORD is set and this link has no password");
            return (
                403,
                json!({
                    "error": "this server only shares albums whose link has a password set",
                    "code": "password_required",
                }),
            );
        }
        _ => {}
    }

    let album_id = link
        .pointer("/album/id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let admin = crate::immich::client::Auth::Admin;
    let Some(album) = crate::immich::access::read_album_as(&client, album_id, &admin).await else {
        return (
            404,
            json!({ "error": "that album is gone", "code": "unknown_album" }),
        );
    };
    let assets = read_album_assets_as(&client, album_id, &admin)
        .await
        .unwrap_or_default();
    let album_name = album
        .get("albumName")
        .and_then(|n| n.as_str())
        .unwrap_or("Shared album")
        .to_string();
    let permissions = if link
        .get("allowUpload")
        .and_then(|a| a.as_bool())
        .unwrap_or(false)
    {
        "contribute"
    } else {
        "view"
    };

    // Enrol the peer. A peer we already know is UPDATED, not duplicated.
    {
        let mut collections = state().collections();
        match collections
            .peers
            .iter_mut()
            .find(|p| p.pub_key == caller_pub)
        {
            Some(existing) => {
                existing.name = household_name.clone();
                if version.is_some() {
                    existing.version = version;
                }
            }
            None => collections.peers.push(crate::store::Peer {
                pub_key: caller_pub.to_string(),
                name: household_name.clone(),
                version,
                protocol: Some(PROTOCOL_VERSION as i64),
                features: None,
                via: "link".to_string(),
                first_seen_at: crate::config::iso_now(),
                relay_hint: None,
                last_addrs: None,
            }),
        }
    }

    // IDEMPOTENT: re-redeeming the same link must reuse the mapping, not mint another. Otherwise a
    // valid link is an unbounded state-growth lever for anyone holding it.
    let existing = state()
        .collections()
        .mappings
        .iter()
        .find(|m| {
            m.role == Role::Owner && m.peer == caller_pub && m.album_id == album_id && !m.dead
        })
        .map(|m| m.id.clone());

    let mapping_id = match existing {
        Some(id) => {
            let mut collections = state().collections();
            if let Some(m) = collections.mappings.iter_mut().find(|m| m.id == id) {
                m.permissions = permissions.to_string();
            }
            id
        }
        None => {
            let id = new_uuid();
            state().collections().mappings.push(Mapping {
                id: id.clone(),
                role: Role::Owner,
                album_id: album_id.to_string(),
                album_name: album_name.clone(),
                peer: caller_pub.to_string(),
                remote_album_id: None,
                remote_mapping_id: None,
                permissions: permissions.to_string(),
                host_slug: None,
                via: "link".to_string(),
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
            });
            crate::log!("peer joined: \"{household_name}\" -> album \"{album_name}\"");
            id
        }
    };
    let _ = state().save();

    let users = crate::immich::client::users_by_id(&client, 0).await;
    let manifest = refs::build_manifest(&assets, &users, ledger_of_state());
    // Entitlement is recorded BEFORE the manifest is advertised: the peer materialises during this
    // call and fetches stub bytes back before any response lands.
    let offered: Vec<String> = manifest.iter().map(|r| r.origin_asset.clone()).collect();
    let _ = state().store.offered_add(&mapping_id, &offered);

    // v3 album responses carry no ownerId — the share link records its creator, which is exactly
    // "the person who shared this"; the majority asset owner is the empty-album fallback.
    let album_owner_id = link
        .get("userId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            album
                .get("ownerId")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .or_else(|| majority_owner(&assets));
    let display_name = match album_owner_id.as_deref() {
        Some(id) => owner_name(&client, id)
            .await
            .unwrap_or_else(|| cfg().name.clone()),
        None => cfg().name.clone(),
    };
    let album_owner = json!({ "displayName": display_name, "originUserId": album_owner_id });

    (
        200,
        json!({
            "protocol": PROTOCOL_VERSION,
            "version": SIDECAR_VERSION,
            "household": { "publicKey": state().keys().public, "name": cfg().name },
            "album": { "id": album_id, "name": album_name, "permissions": permissions },
            "albumOwner": album_owner,
            "manifest": manifest,
            "mappingId": mapping_id,
        }),
    )
}

/// The owner of most of an album's assets — the fallback when neither the link nor the album names
/// one, which is the empty-proof answer for an album whose assets all have the same owner.
fn majority_owner(assets: &[Value]) -> Option<String> {
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for asset in assets {
        if let Some(owner) = asset.get("ownerId").and_then(|v| v.as_str()) {
            *counts.entry(owner).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(owner, _)| owner.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse an ISO-8601 UTC timestamp to milliseconds. Enough for Immich's `expiresAt`, whose shape is
/// fixed — this exists so the expiry check needs no date library.
fn chrono_parse_ms(value: &str) -> Result<i64, ()> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return Err(());
    }
    let num = |from: usize, to: usize| -> Result<i64, ()> {
        std::str::from_utf8(&bytes[from..to])
            .map_err(|_| ())?
            .parse::<i64>()
            .map_err(|_| ())
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        num(20, 23)?
    } else {
        0
    };
    let days = days_from_civil(y, mo, d);
    Ok((days * 86_400 + h * 3600 + mi * 60 + s) * 1000 + millis)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm), used only by the expiry check above.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A v4-shaped UUID, so mapping ids look like the ones the TypeScript mints.
fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// True when this server accepts album joins via share links at all.
pub fn share_link_joining_enabled() -> bool {
    Settings::read(&state().store).share_link_join
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_equal_only_when_identical() {
        assert!(secret_equals("hunter2", "hunter2"));
        assert!(!secret_equals("hunter2", "hunter3"));
        assert!(!secret_equals("", "x"));
        assert!(secret_equals("", ""));
    }

    #[test]
    fn a_length_mismatch_does_not_leak_through_an_early_return() {
        // The compare must not simply return on the first difference in length: it performs one
        // equal-length comparison so the work does not reveal which branch ran.
        assert!(!secret_equals("short", "a-much-longer-secret"));
        assert!(!secret_equals("a-much-longer-secret", "short"));
        // A prefix must not match.
        assert!(!secret_equals("hunter2", "hunter22"));
        assert!(!secret_equals("hunter22", "hunter2"));
    }

    #[test]
    fn a_uuid_has_the_v4_shape_the_typescript_mints() {
        let id = new_uuid();
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        // Version 4 and the RFC variant bits, so ids sort and parse as UUIDs.
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, new_uuid(), "each id is fresh");
    }

    #[test]
    fn an_iso_expiry_parses_to_the_right_instant() {
        // 2026-01-01T00:00:00.000Z
        assert_eq!(
            chrono_parse_ms("2026-01-01T00:00:00.000Z").unwrap(),
            1_767_225_600_000
        );
        // The epoch itself, and a time with no fractional part.
        assert_eq!(chrono_parse_ms("1970-01-01T00:00:00Z").unwrap(), 0);
        assert!(chrono_parse_ms("not a date").is_err());
        assert!(chrono_parse_ms("").is_err());
    }

    #[test]
    fn date_arithmetic_matches_known_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1, "before the epoch");
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
    }

    #[test]
    fn the_majority_owner_is_the_most_common_and_none_when_no_asset_has_one() {
        let assets = vec![
            json!({"ownerId": "a"}),
            json!({"ownerId": "b"}),
            json!({"ownerId": "b"}),
        ];
        assert_eq!(majority_owner(&assets).as_deref(), Some("b"));
        assert_eq!(majority_owner(&[]).as_deref(), None);
        assert_eq!(majority_owner(&[json!({})]).as_deref(), None);
    }

    #[test]
    fn removal_targets_name_only_rows_the_sender_actually_sourced() {
        // Only rows that name a source matching the sender's list may be purged. The caller
        // scopes the rows to the push's mapping, so a peer can only ever withdraw stubs its own
        // share created; a row without a known source names nothing removable.
        let row = |checksum: &str, local: &str, origin: Option<&str>| crate::store::SeenEntry {
            mapping: "m1".into(),
            checksum: checksum.into(),
            local_asset: local.into(),
            origin_asset: origin.map(str::to_string),
            stored_full: false,
        };
        let rows = vec![
            row("c1", "local-1", Some("asset-1")),
            row("c2", "local-2", None),
            row("c3", "local-3", Some("asset-3")),
        ];
        assert_eq!(
            removal_targets(&rows, &["asset-1".into(), "asset-9".into()]),
            vec![("c1".to_string(), "local-1".to_string())]
        );
        assert!(removal_targets(&rows, &[]).is_empty());
        assert!(removal_targets(&[], &["asset-1".into()]).is_empty());
    }
}

/// Find one of THIS peer's mappings by id, album id or remote album id.
///
/// Always filtered on the calling peer's key: a valid connection can never select someone else's
/// album. `role` narrows it where the route means a specific direction — an owner-side route must
/// not match the member mirror that faces the same peer.
pub fn mapping_for(
    state: &crate::state::State,
    peer_pub: &str,
    reference: &str,
    role: Option<Role>,
) -> Option<Mapping> {
    state
        .collections()
        .mappings
        .iter()
        .find(|m| {
            m.peer == peer_pub
                && role.map(|r| m.role == r).unwrap_or(true)
                && (m.id == reference
                    || m.album_id == reference
                    || m.remote_album_id.as_deref() == Some(reference))
        })
        .cloned()
}

/// 404 means "try again" — transient, or a mapping the caller mis-addressed. 410 means the
/// relationship is OVER, so the receiver tears down its side rather than retrying forever.
pub fn gone_or_404(
    state: &crate::state::State,
    peer_pub: &str,
    album_mapping_id: &str,
) -> (u16, Value) {
    let dead = state.collections().mappings.iter().any(|m| {
        m.peer == peer_pub
            && m.dead
            && (m.id == album_mapping_id
                || m.album_id == album_mapping_id
                || m.remote_album_id.as_deref() == Some(album_mapping_id))
    });
    if dead {
        (
            410,
            json!({ "error": "this share was withdrawn", "code": "gone" }),
        )
    } else {
        (
            404,
            json!({ "error": "unknown album mapping", "code": "unknown_mapping" }),
        )
    }
}

/// The local stubs a sender's `remove` list names: ledger rows of THIS mapping whose
/// `originAsset` is an id the sender says it no longer holds. The caller scopes the rows to the
/// push's mapping (the store filters on mapping), so a peer can only withdraw stubs its own share
/// created; rows without a known source name nothing the sender could have offered.
pub fn removal_targets(
    rows: &[crate::store::SeenEntry],
    removed_origin_assets: &[String],
) -> Vec<(String, String)> {
    rows.iter()
        .filter_map(|row| {
            let origin = row.origin_asset.as_deref()?;
            removed_origin_assets
                .iter()
                .find(|id| *id == origin)
                .map(|_| (row.checksum.clone(), row.local_asset.clone()))
        })
        .collect()
}

/// The version handshake: one cheap album read instead of a full manifest scan. Members compare
/// this against their stored cursor and pull the manifest only on a mismatch.
pub async fn handle_version(caller_pub: &str, album_mapping_id: &str) -> (u16, Value) {
    let state = crate::state::state();
    if !crate::p2p::entitlement::is_enrolled(state, caller_pub) {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    }
    let Some(mapping) = mapping_for(state, caller_pub, album_mapping_id, Some(Role::Owner)) else {
        return gone_or_404(state, caller_pub, album_mapping_id);
    };
    if mapping.dead {
        return gone_or_404(state, caller_pub, album_mapping_id);
    }
    let client = Client::new();
    let album =
        crate::immich::access::read_album_as(&client, &mapping.album_id, &admin_auth()).await;
    let Some(album) = album else {
        return gone_or_404(state, caller_pub, album_mapping_id);
    };
    let updated_at = album
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let asset_count = album.get("assetCount").and_then(|v| v.as_i64());
    let comments = client
        .get(
            &format!("/activities/statistics?albumId={}", mapping.album_id),
            &admin_auth(),
        )
        .await
        .ok()
        .flatten()
        .and_then(|v| v.get("comments").and_then(|c| c.as_i64()));
    // `version` is an OPAQUE equality token. The packed shape is kept for protocol-2 compatibility
    // (updatedAt alone misses cascade deletions), but receivers read the structured fields and
    // never parse the string.
    (
        200,
        json!({
            "version": format!("{updated_at}|{}", asset_count.map(|c| c.to_string()).unwrap_or_default()),
            "updatedAt": updated_at,
            "assetCount": asset_count,
            "comments": comments,
        }),
    )
}

/// Members re-pull this to heal refs missed at join time, and the reconciler pulls it on a version
/// mismatch. Entitlement is recorded BEFORE the manifest is advertised.
pub async fn handle_manifest(caller_pub: &str, album_mapping_id: &str) -> (u16, Value) {
    let state = crate::state::state();
    if !crate::p2p::entitlement::is_enrolled(state, caller_pub) {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    }
    let Some(mapping) = mapping_for(state, caller_pub, album_mapping_id, Some(Role::Owner)) else {
        return gone_or_404(state, caller_pub, album_mapping_id);
    };
    if mapping.dead {
        return gone_or_404(state, caller_pub, album_mapping_id);
    }
    let client = Client::new();
    let Some(assets) =
        crate::immich::access::read_album_assets_as(&client, &mapping.album_id, &admin_auth())
            .await
    else {
        return gone_or_404(state, caller_pub, album_mapping_id);
    };
    let users = crate::immich::client::users_by_id(&client, 60_000).await;
    let manifest = refs::build_manifest(&assets, &users, ledger_of_state());
    crate::p2p::entitlement::record_offered_refs(state, &mapping.id, &manifest);
    (200, json!({ "manifest": manifest }))
}

/// Whether a mapping has converged. `album` is read here so the answer is about NOW rather than
/// about the last pass.
pub async fn handle_status(caller_pub: &str, album_mapping_id: &str) -> (u16, Value) {
    let state = crate::state::state();
    if !crate::p2p::entitlement::is_enrolled(state, caller_pub) {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    }
    let Some(mapping) = mapping_for(state, caller_pub, album_mapping_id, Some(Role::Owner)) else {
        return gone_or_404(state, caller_pub, album_mapping_id);
    };
    if mapping.dead {
        return gone_or_404(state, caller_pub, album_mapping_id);
    }
    let client = Client::new();
    let updated_at =
        crate::immich::access::read_album_as(&client, &mapping.album_id, &admin_auth())
            .await
            .and_then(|album| {
                album
                    .get("updatedAt")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            });
    let status = crate::sync::status::sync_status(
        &mapping,
        updated_at.as_deref(),
        crate::sync::status::watcher_cycles(&mapping.id),
    );
    (200, serde_json::to_value(status).unwrap_or(Value::Null))
}

/// A peer reporting that the share we gave it is now part of a reunion on their side.
///
/// A FACT, not a command: it records what happened and asks for nothing back. Adoption only ever
/// happens on the RECEIVING side, so the mapping this lands on is the one whose album is ours —
/// scoping to the caller is what stops a peer naming a mapping that is not theirs, and the role
/// keeps it to shares we actually handed over.
pub fn handle_reunified(state: &State, caller_pub: &str, album_mapping_id: &str) -> (u16, Value) {
    let Some(peer) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == caller_pub)
        .cloned()
    else {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    };
    let Some(mapping) = mapping_for(state, &peer.pub_key, album_mapping_id, Some(Role::Owner))
    else {
        return gone_or_404(state, &peer.pub_key, album_mapping_id);
    };
    if mapping.dead {
        return gone_or_404(state, &peer.pub_key, album_mapping_id);
    }
    {
        let mut collections = state.collections();
        if let Some(live) = collections.mappings.iter_mut().find(|m| m.id == mapping.id) {
            live.reunified = Some(true);
        }
    }
    let _ = state.save();
    crate::log!(
        "\"{}\" reunited the share of \"{}\" — it is no longer a possible reunion",
        peer.name,
        mapping.album_name
    );
    // The inviter's panel lists this pair under "Possible album reunions" until told, and a page
    // already open has to be told the same way it is told everything else.
    crate::web::panel_events::emit(crate::web::panel_events::PanelEvent::Shares);
    // The trail on OUR album too, where the invitation was made: the person who invited is told in
    // the album itself, not only in their panel. Deliberately unawaited — the peer's request is
    // answered either way, and the line is worth a retry rather than worth holding their panel open.
    // `crate::state::state()` rather than the `&State` this call was given: the spawned task owns
    // what it touches, and there is one state per process.
    let owned_state = crate::state::state().clone();
    let album_id = mapping.album_id.clone();
    let mapping_id = mapping.id.clone();
    let peer_name = peer.name.clone();
    tokio::spawn(async move {
        crate::sync::audit::audit_line(
            &owned_state,
            crate::immich::client::shared(),
            &mapping_id,
            &album_id,
            "accepted",
            &format!(
                "{peer_name} accepted — the two albums are merged, and the photos both sides hold show once."
            ),
        )
        .await;
    });
    (200, json!({ "ok": true }))
}

/// Ask every linked peer what it can do, and record the answer on the peer row.
///
/// A peer too old to know `/hello` answers 404, which reads as protocol 2 with no features — the
/// baseline every build speaks. Best-effort: an unreachable peer keeps what is stored and the next
/// boot retries.
pub async fn hello_peers(state: &State) {
    let peers: Vec<crate::store::Peer> = state.collections().peers.clone();
    let Some(transport) = crate::p2p::transport::transport() else {
        return;
    };
    for peer in peers {
        let header = crate::p2p::frame::RequestHeader {
            path: "/hello".into(),
            ..Default::default()
        };
        let (protocol, features, version) = match transport.round_trip(&peer, &header, None).await {
            Ok((head, body)) if head.status < 400 => {
                let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let protocol = parsed.get("protocol").and_then(|v| v.as_i64());
                let features = parsed
                    .get("features")
                    .and_then(|v| v.as_array())
                    .map(|names| {
                        names
                            .iter()
                            .filter_map(|n| n.as_str().map(str::to_string))
                            .collect()
                    });
                let version = parsed
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                (protocol, features, version)
            }
            // "Peer too old" rather than an error: every build speaks protocol 2.
            Ok((head, _)) if head.status == 404 => (Some(2), Some(Vec::new()), None),
            _ => continue,
        };
        {
            let mut collections = state.collections();
            if let Some(live) = collections
                .peers
                .iter_mut()
                .find(|p| p.pub_key == peer.pub_key)
            {
                live.protocol = protocol;
                live.features = features;
                if version.is_some() {
                    live.version = version;
                }
            }
        }
        let _ = state.save();
    }
}

/// `POST /albums/:mappingId/nudge` the peer sends: "look at this album again".
///
/// A nudge only means "look again"; it must never get to say WHERE to look. Scoping the lookup to
/// the caller is what enforces that — `mapping_for` already guarantees `mapping.peer == caller`, and
/// the origin is resolved from the mapping rather than from the request so that stays true.
pub fn handle_nudge(caller_pub: &str, album_mapping_id: &str) -> (u16, Value) {
    let state = crate::state::state();
    let Some(caller) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == caller_pub)
        .cloned()
    else {
        return (403, json!({ "error": "unknown peer" }));
    };
    let Some(mapping) = mapping_for(state, &caller.pub_key, album_mapping_id, None) else {
        return (404, json!({ "error": "unknown album mapping" }));
    };
    if mapping.dead {
        return (404, json!({ "error": "unknown album mapping" }));
    }
    let Some(origin) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == mapping.peer)
        .cloned()
    else {
        return (404, json!({ "error": "unknown album mapping" }));
    };
    crate::sync::status::record_nudge(crate::sync::status::NudgeKind::Album);
    // Answer fast; do the pull in the background. Deliberately unawaited — the peer is waiting on an
    // acknowledgement, not on the work.
    let owned_state = state.clone();
    tokio::spawn(async move {
        if mapping.role == Role::Member {
            let client = crate::immich::client::shared();
            if let Err(e) =
                // FORCED: a nudge means "look again now" — the thing that changed may be invisible
                // to the version token (a caption edit moves no album row).
                crate::sync::engine::reconcile_mapping(
                    &owned_state,
                    client,
                    &mapping,
                    &origin,
                    true,
                )
                .await
            {
                crate::log!("nudge pull error on \"{}\": {e}", mapping.album_name);
            }
            crate::sync::comments::pull_canonical_comments(&owned_state, client, &mapping, &origin)
                .await;
        }
    });
    (200, json!({ "ok": true }))
}

/// `POST /index/nudge` — "what you offer me has changed, read my index again".
///
/// The sibling of the album nudge, and the same contract: it carries no names and no albums, so a
/// peer can only cause a re-read of what the caller ALREADY published for it.
pub fn handle_index_nudge(caller_pub: &str) -> (u16, Value) {
    let state = crate::state::state();
    let Some(caller) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == caller_pub)
        .cloned()
    else {
        return (403, json!({ "error": "unknown peer" }));
    };
    crate::sync::status::record_nudge(crate::sync::status::NudgeKind::Index);
    // ONLY THE CALLER: a nudge says "what I publish has changed", and refreshing every linked peer
    // would let one enrolled peer make this server dial all of them once per request.
    let owned_state = state.clone();
    tokio::spawn(async move {
        crate::sync::album_index::refresh_peer_albums(&owned_state, &caller).await;
    });
    (200, json!({ "ok": true }))
}

/// A peer telling us it has left, or that it is withdrawing. The courtesy signal: the mapping dies
/// here without waiting for a 404 to be discovered by a push.
pub fn handle_leave(caller_pub: &str, album_mapping_id: &str) -> (u16, Value) {
    let state = crate::state::state();
    if !crate::p2p::entitlement::is_enrolled(state, caller_pub) {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    }
    // Deliberately NOT `gone_or_404`: a plain 404 here even when the mapping is already dead, so a
    // repeated leave is idempotent rather than reporting a relationship that is already over.
    // The id resolved HERE is the one reclaimed below. Re-searching afterwards matched on the album
    // alone, which one album shared to several peers makes ambiguous — a leave from peer A could
    // reclaim peer B's offered rows — and a caller that addressed the mapping by `remote_album_id`
    // matched nothing at all, so its rows were never released.
    let mapping_id = {
        let mut collections = state.collections();
        match collections.mappings.iter_mut().find(|m| {
            m.peer == caller_pub
                && (m.id == album_mapping_id
                    || m.album_id == album_mapping_id
                    || m.remote_album_id.as_deref() == Some(album_mapping_id))
        }) {
            Some(m) => {
                m.dead = true;
                m.dead_at = Some(crate::config::iso_now());
                m.dead_reason = Some("member left".to_string());
                Some(m.id.clone())
            }
            None => None,
        }
    };
    let Some(mapping_id) = mapping_id else {
        return (404, json!({ "error": "unknown album mapping" }));
    };
    // Reclaim what the dead mapping was holding, exactly as a leave does locally.
    crate::p2p::entitlement::forget_offered(state, &mapping_id);
    crate::sync::status::forget_watcher_cycles(&mapping_id);
    let _ = state.save();
    (200, json!({ "ok": true }))
}

fn admin_auth() -> crate::immich::client::Auth<'static> {
    crate::immich::client::Auth::Admin
}

/// A peer pushing what is new in an album of theirs.
///
/// The role gate is the subtle part: `permissions` on a MEMBER mapping means what WE may do at the
/// origin, not what the peer may do here, so gating on it refused the origin's own downward pushes
/// to view-only mirrors — and since content then only ever arrived via the manifest pull, the
/// origin re-pushed every cycle forever. Only an OWNER mapping's `permissions` speaks for what the
/// link granted the peer.
pub async fn handle_refs(caller_pub: &str, album_mapping_id: &str, body: &[u8]) -> (u16, Value) {
    let state = crate::state::state();
    if !crate::p2p::entitlement::is_enrolled(state, caller_pub) {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    }
    // NO role filter here: a push may arrive for either direction of mapping.
    let Some(mapping) = mapping_for(state, caller_pub, album_mapping_id, None) else {
        return gone_or_404(state, caller_pub, album_mapping_id);
    };
    if mapping.dead {
        return gone_or_404(state, caller_pub, album_mapping_id);
    }
    if mapping.role == Role::Owner && mapping.permissions == "view" {
        return (
            403,
            json!({ "error": "view-only album — uploads not allowed", "code": "view_only" }),
        );
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        return (400, json!({ "error": "malformed request" }));
    };
    let refs: Vec<refs::AssetRef> = parsed
        .get("add")
        .and_then(|a| serde_json::from_value(a.clone()).ok())
        .unwrap_or_default();
    // The push may also carry what the sender no longer holds: origin asset ids whose stubs here
    // must go (a joiner deleted their own contribution — nothing else tells this side). ADDITIVE
    // and optional: a peer that never sends it behaves exactly as before, and a receiver that
    // ignores it just keeps today's behaviour. Scoped to THIS mapping's ledger, so a peer can
    // only ever withdraw stubs its own share created.
    let remove: Vec<String> = parsed
        .get("remove")
        .and_then(|r| serde_json::from_value(r.clone()).ok())
        .unwrap_or_default();
    let Some(peer) = state
        .collections()
        .peers
        .iter()
        .find(|p| p.pub_key == caller_pub)
        .cloned()
    else {
        return (
            403,
            json!({ "error": "unknown peer", "code": "unknown_peer" }),
        );
    };

    let client = Client::new();
    // REMOVE FIRST, before any await: the rows are looked up and bound here, the purges run
    // after. Each purge is guarded by `delete_proxy_asset` (only utility-owned assets go), so a
    // hostile or confused `remove` cannot reach a household's own photos.
    let targets = removal_targets(
        &state
            .store
            .seen_for_mapping(&mapping.id)
            .unwrap_or_default(),
        &remove,
    );
    let mut removed = 0usize;
    for (checksum, local_asset) in &targets {
        match crate::immich::materialise::delete_proxy_asset(state, &client, local_asset).await {
            Ok(crate::immich::materialise::PurgeOutcome::Purged)
            | Ok(crate::immich::materialise::PurgeOutcome::AlreadyGone) => {
                let _ = state.store.seen_remove_entry(&mapping.id, checksum);
                removed += 1;
                crate::log!(
                    "removed a stub the sender no longer holds (\"{}\")",
                    mapping.album_name
                );
            }
            Ok(crate::immich::materialise::PurgeOutcome::NotOurs) | Err(_) => {
                crate::log!(
                    "stub removal refused, keeping it (\"{}\")",
                    mapping.album_name
                );
            }
        }
    }

    let mut failed: Vec<String> = Vec::new();
    for reference in &refs {
        match crate::immich::materialise::materialise_ref(
            state, &client, &mapping, &peer, reference,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => failed.push(reference.checksum.clone()),
            Err(e) => {
                crate::log!(
                    "ref materialise failed ({}): {e}",
                    &reference.checksum[..reference.checksum.len().min(10)]
                );
                failed.push(reference.checksum.clone());
            }
        }
    }
    // PARTIAL SUCCESS is the contract: the sender re-offers only the failed refs next cycle, so one
    // bad photo cannot wedge an album. Removals are NOT retried by the sender — a purge that was
    // refused stays and is logged, because retrying a refusal would only refuse again.
    (
        200,
        json!({ "ok": failed.is_empty(), "failed": failed, "removed": removed }),
    )
}
