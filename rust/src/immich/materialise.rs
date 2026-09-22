/** immich/materialise.rs — making a peer's photo a real row in this household's library. See PORT.md. */

use crate::immich::client::{
    add_to_album, apply_ref_metadata, stub_jpeg, upload_asset, Client,
};
use crate::immich::contributors::ensure_contributor;
use crate::immich::refs::AssetRef;
use crate::media::jpeg::jpeg_of_size;
use crate::p2p::transport::transport;
use crate::state::State;
use crate::store::{Mapping, Peer, Role};
use crate::sync::album_suppression::existing_copy_in_album;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// An oversize original falls back to a stub rather than filling the disk. 256 MiB is generous for
/// a photo and reaches most short videos; the point is a bound, not a policy.
const MAX_FULL_BYTES: usize = 256 * 1024 * 1024;

/// We ASK a peer for a 2 MiB playback prefix. A peer that answers with the whole original must cost
/// a failed ref, not our heap.
const VIDEO_PREFIX_BYTES: usize = 2 * 1024 * 1024;
const VIDEO_PREFIX_GUARD: usize = 4 * 1024 * 1024;

/// What we asked for, and what to call it locally: Immich decides photo-vs-video from the filename
/// extension, so `ext` is load-bearing rather than cosmetic.
const CT_EXT: [(&str, &str); 6] = [
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
    ("image/heic", "heic"),
    ("video/mp4", "mp4"),
    ("video/quicktime", "mov"),
];

fn ext_for_content_type(content_type: &str) -> Option<&'static str> {
    let base = content_type.split(';').next().unwrap_or("").trim();
    CT_EXT.iter().find(|(ct, _)| *ct == base).map(|(_, ext)| *ext)
}

/// One flight per ALBUM and photo, not per mapping. The suppression below is album-level, so keying
/// this per mapping would let two mappings of the SAME album both look, both find no row, and both
/// upload — each holding its own flight key, so neither is stopped.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Fetch the owner's FULL original, so an album can survive the owner going offline.
///
/// Returns `None` to mean "use a stub instead" and `Err` to mean "retry this ref later" — the two
/// are different answers and must not collapse into one.
pub(crate) async fn fetch_full_original(
    peer: &Peer,
    reference: &AssetRef,
    mapping_id: &str,
) -> Result<Option<(Vec<u8>, String)>, ()> {
    let Some(transport) = transport() else { return Ok(None) };
    let path = format!("/assets/{}/original", reference.origin_asset);
    let (head, body) = match transport.byte_request(peer, &path, None, Some(mapping_id)).await {
        Ok(v) => v,
        Err(e) => {
            crate::log!("full-copy fetch for {} failed ({e}) — will retry", reference.origin_asset);
            return Err(());
        }
    };
    if head.status >= 400 {
        crate::log!("full-copy fetch for {} answered {} — will retry", reference.origin_asset, head.status);
        return Err(());
    }
    if body.len() > MAX_FULL_BYTES {
        return Ok(None);
    }
    let ext = head
        .headers
        .as_ref()
        .and_then(|h| h.get("content-type"))
        .and_then(|ct| ext_for_content_type(ct))
        .unwrap_or(if reference.kind == "video" { "mp4" } else { "jpg" })
        .to_string();
    Ok(Some((body, ext)))
}

/// Bring one ref into the local library: a stub (the default) or a full copy.
///
/// Returns `true` when the photo is now accounted for — either materialised, or already here.
pub async fn materialise_ref(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    reference: &AssetRef,
) -> Result<bool, String> {
    if state.store.seen_has(&mapping.id, &reference.checksum).unwrap_or(false) {
        return Ok(true);
    }
    let flight_key = format!("{}:{}", mapping.album_id, reference.checksum);
    {
        let mut flights = in_flight().lock().unwrap();
        if flights.contains(&flight_key) {
            return Ok(false);
        }
        flights.insert(flight_key.clone());
    }
    let result = materialise_flight(state, client, mapping, peer, reference).await;
    in_flight().lock().unwrap().remove(&flight_key);
    result
}

async fn materialise_flight(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    reference: &AssetRef,
) -> Result<bool, String> {
    // Re-run BOTH checks now the flight is ours: whoever held it may have recorded exactly the row
    // this is looking for, and an album-level duplicate is the one thing it must not miss.
    if state.store.seen_has(&mapping.id, &reference.checksum).unwrap_or(false) {
        return Ok(true);
    }
    let rows = state.store.seen_for_checksum(&reference.checksum).unwrap_or_default();
    let mappings = state.collections().mappings.clone();
    if let Some(already) = existing_copy_in_album(&mapping.album_id, &reference.checksum, &mappings, &rows) {
        // Point at the stub the album already has instead of making a second one. The row is
        // recorded for THIS mapping because the version cursor and the deletion sweep both read it:
        // when this mapping's peer stops offering the photo, its sweep retracts the row, and the
        // stub survives on the other mapping's claim.
        let _ = state.store.seen_add(
            &mapping.id,
            &reference.checksum,
            &already.local_asset,
            reference.origin_asset.as_str().into(),
            already.stored_full,
        );
        return Ok(true);
    }
    materialise_upload(state, client, mapping, peer, reference).await
}

async fn materialise_upload(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    reference: &AssetRef,
) -> Result<bool, String> {
    let mut ext = if reference.kind == "video" { "mp4" } else { "jpg" }.to_string();
    let mut stored_full = false;

    // Default is the hotlink model: nothing of the photo is stored, just a tiny stub the app can
    // render while every pixel streams live from the owner. With store-shared-locally on, the FULL
    // original is kept instead so the album survives the owner going offline.
    let mut bytes: Option<Vec<u8>> = None;
    if state.store_shared_assets_locally() {
        match fetch_full_original(peer, reference, &mapping.id).await {
            Err(()) => return Ok(false),
            Ok(Some((full, full_ext))) => {
                bytes = Some(full);
                ext = full_ext;
                stored_full = true;
            }
            Ok(None) => crate::log!(
                "{} is over the local-copy size cap — keeping a hotlink stub",
                reference.origin_asset
            ),
        }
    }

    // The stub path COMPUTES a value; the full-copy path already has one. A `let..else` would be
    // wrong here because the else branch produces a value rather than diverging.
    let bytes = match bytes {
        Some(full) => full,
        None => {
        let stub = if reference.kind == "video" {
            // A playable 2 MiB prefix so the tile carries a real poster and duration; the rest
            // streams on demand.
            let Some(transport) = transport() else { return Ok(false) };
            let path = format!("/assets/{}/playback", reference.origin_asset);
            match transport
                .byte_request(peer, &path, Some("bytes=0-2097151"), Some(&mapping.id))
                .await
            {
                Ok((head, body)) if head.status < 400 => {
                    if body.len() > VIDEO_PREFIX_GUARD {
                        // We asked for 2 MiB; a peer that ignored the range must not cost us heap.
                        crate::log!("playback stub for {} ignored the range (>4MB) — deferring", reference.origin_asset);
                        return Ok(false);
                    }
                    let _ = VIDEO_PREFIX_BYTES;
                    body
                }
                Ok((head, _)) => {
                    crate::log!("playback stub fetch failed for {}: {}", reference.origin_asset, head.status);
                    return Ok(false);
                }
                Err(e) => {
                    crate::log!("playback stub fetch error for {}: {e}", reference.origin_asset);
                    return Ok(false);
                }
            }
        } else {
            // Size the stub to the origin's aspect ratio so Immich lays the mirror out correctly (the
            // grid tile's shape and the viewer's box). A ref from an older peer carries no dimensions,
            // so it falls back to the legacy 1x1 stub.
            match reference.exif.as_ref().and_then(|e| Some((e.width?, e.height?))) {
                Some((w, h)) => jpeg_of_size(w as f64, h as f64),
                None => stub_jpeg(),
            }
        };
        // The random tail keeps each stub a DISTINCT asset: Immich dedupes identical bytes per user.
        let mut with_tail = stub;
        let mut tail = [0u8; 8];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut tail);
        with_tail.extend_from_slice(&tail);
        with_tail
        }
    };

    let uploaded_id = upload_as_contributor(state, client, mapping, peer, reference, &bytes, &ext).await?;
    let _ = state.store.seen_add(
        &mapping.id,
        &reference.checksum,
        &uploaded_id,
        Some(&reference.origin_asset),
        stored_full,
    );
    crate::log!(
        "materialised {} ref from \"{}\" into \"{}\"",
        if stored_full { "full copy of" } else { "stub for" },
        contributor_display_name(peer, reference),
        mapping.album_name
    );
    Ok(true)
}

/// The name a photo is attributed to here: the contributor the origin named, or the household.
fn contributor_display_name(peer: &Peer, reference: &AssetRef) -> String {
    if reference.contributor.display_name.is_empty() {
        peer.name.clone()
    } else {
        reference.contributor.display_name.clone()
    }
}

/// Upload bytes as the contributor who owns them and file them into the album.
///
/// The MEMBERSHIP rules are the security property and live here once, for both the first
/// materialisation and the store-locally backfill.
pub(crate) async fn upload_as_contributor(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    reference: &AssetRef,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    // `None` is legitimate and means the HOUSEHOLD key: `hostSlug` names a stand-in only on a
    // MIRROR, so an owner mapping — this household's own album, owned by a human — has none. The
    // TypeScript treats a missing host key the same way, by letting its default (admin) key apply.
    let host_key = mapping
        .host_slug
        .as_ref()
        .and_then(|slug| state.collections().contributors.get(slug).and_then(|c| c.api_key.clone()));

    // On an INVITATION album a human already added the people they chose — their membership IS the
    // share. So for an invited person we must never add them: if they are missing, that absence is
    // the revocation, and filling it in would overrule the human. That, not a ledger, is what
    // removes the revoke-versus-arriving-content race.
    //
    // Link-shared albums are the opposite: the link named a household, nobody named a person, so
    // attribution has no membership to inherit and the sidecar does have to create one.
    let contributor_id = reference.contributor.origin_user_id.clone();
    let missing_member_means_revoked = mapping.via == "invite"
        && contributor_id
            .as_deref()
            .map(|id| {
                mapping
                    .for_peer_user_ids
                    .as_ref()
                    .map(|ids| ids.iter().any(|i| i == id))
                    .unwrap_or(false)
            })
            .unwrap_or(false);

    let display_name = contributor_display_name(peer, reference);
    let contributor = ensure_contributor(
        state,
        client,
        &display_name,
        &mapping.album_id,
        &crate::immich::contributors::host_auth(host_key.as_deref()),
        contributor_id.as_deref(),
        Some(&mapping.peer),
        !missing_member_means_revoked,
        false,
    )
    .await?;
    let Some(contributor_key) = contributor.api_key.clone() else {
        return Err(format!("contributor \"{display_name}\" has no API key yet — will retry"));
    };

    // Base64 checksums contain `/` and `+` — never let them into filenames.
    let slug: String = reference
        .checksum
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    let filename = format!("shared-{slug}.{ext}");
    let uploaded = upload_asset(client, bytes, &filename, &contributor_key, reference.taken_at.as_deref())
        .await
        .map_err(|e| e.message())?;
    let Some(uploaded_id) = uploaded.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
        return Err(format!("upload of {filename} returned no asset id"));
    };

    add_to_album(client, &mapping.album_id, &[uploaded_id.clone()], &contributor_key)
        .await
        .map_err(|e| e.message())?;
    apply_ref_metadata(client, &uploaded_id, reference, &contributor_key).await;
    Ok(uploaded_id)
}

/// Replace one stub with a full local copy, for the store-shared-locally backfill.
///
/// Upload the full bytes FIRST, so there is never a gap with no asset; swap the ledger to point at
/// the full copy; then delete the stub. A crash between the swap and the delete leaves a stray grey
/// stub — harmless and rare — rather than losing the photo.
///
/// `false` means "leave the stub in place": a transient fetch failure, or an original over the
/// local-copy cap.
pub async fn upgrade_stub_to_full(
    state: &State,
    client: &Client,
    mapping: &Mapping,
    peer: &Peer,
    reference: &AssetRef,
    stub_asset_id: &str,
) -> Result<bool, String> {
    let Some((bytes, ext)) = fetch_full_original(peer, reference, &mapping.id).await.map_err(|()| {
        format!("could not fetch the original of {} — will retry", reference.origin_asset)
    })? else {
        return Ok(false);
    };
    let uploaded_id = upload_as_contributor(state, client, mapping, peer, reference, &bytes, &ext).await?;
    // REMOVE FIRST: `seen_add` ignores a row the stub already wrote, so without this the ledger keeps
    // pointing at the stub and every cycle retries the same upgrade.
    let _ = state.store.seen_remove_entry(&mapping.id, &reference.checksum);
    let _ = state.store.seen_add(
        &mapping.id,
        &reference.checksum,
        &uploaded_id,
        Some(&reference.origin_asset),
        true,
    );
    crate::immich::materialise::delete_proxy_asset(state, client, stub_asset_id).await.ok();
    Ok(true)
}

/// Delete a materialised proxy asset. Hard guard: only utility-owned assets are ever deleted, so a
/// human's photo can never be removed by this path even if a ledger row pointed at it.
/// What became of a stored copy we asked to remove. Returned rather than a bool so a caller can
/// never mistake "I could not see it" for "it is gone", and can say which happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeOutcome {
    /// It was there and we deleted it. The space came back.
    Purged,
    /// No credential this household holds can see it: absent, or absent to us. Either way there is
    /// nothing left to collect.
    AlreadyGone,
    /// It exists and belongs to an account we hold no key for. Refused, rather than reaching for
    /// the admin key and deleting something that is not ours to delete.
    NotOurs,
}

pub async fn delete_proxy_asset(
    state: &State,
    client: &Client,
    asset_id: &str,
) -> Result<PurgeOutcome, String> {
    // Immich scopes reads per credential, and a stub is owned by a per-person STAND-IN, so the
    // admin key alone cannot see it. Ask the admin first — one request, and a real admin key sees
    // everything — then fall back to each stand-in we hold a key for.
    let mut seen_by_admin = false;
    let mut owner_id = String::new();

    match client.get(&format!("/assets/{asset_id}"), &crate::immich::client::Auth::Admin).await {
        Ok(Some(asset)) => {
            seen_by_admin = true;
            owner_id = asset.get("ownerId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        }
        Ok(None) => {}
        // A 4xx means the admin cannot see it, which is the expected case for a stand-in's asset:
        // fall through to the credentials below rather than failing the purge.
        Err(e) if e.is_not_visible() => {}
        Err(e) => return Err(e.message()),
    }

    // Snapshot the stand-in credentials: `collections()` hands back a std MutexGuard, which cannot
    // be held across the awaits below.
    let stand_ins: Vec<(String, String)> = state
        .collections()
        .contributors
        .values()
        .filter_map(|c| Some((c.user_id.clone()?, c.api_key.clone()?)))
        .collect();

    if !seen_by_admin {
        // The admin cannot see it. Exactly one stand-in owns it; find the one that can.
        for (_, key) in &stand_ins {
            match client.get(&format!("/assets/{asset_id}"), &crate::immich::client::Auth::Key(key)).await {
                Ok(Some(asset)) => {
                    owner_id = asset.get("ownerId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    break;
                }
                Ok(None) => {}
                Err(e) if e.is_not_visible() => {}
                Err(e) => return Err(e.message()),
            }
        }
        if owner_id.is_empty() {
            return Ok(PurgeOutcome::AlreadyGone);
        }
    }

    let owner_key = stand_ins
        .iter()
        .find(|(user_id, _)| user_id == &owner_id)
        .map(|(_, key)| key.clone());
    let Some(owner_key) = owner_key else {
        crate::log!("refusing to delete {asset_id}: owned by {owner_id}, which is not an account we hold a key for");
        return Ok(PurgeOutcome::NotOurs);
    };
    client
        .json(
            reqwest::Method::DELETE,
            "/assets",
            &crate::immich::client::Auth::Key(&owner_key),
            Some(&serde_json::json!({ "ids": [asset_id], "force": true })),
        )
        .await
        .map_err(|e| e.message())?;
    Ok(PurgeOutcome::Purged)
}

/// Does this mapping have any stub rows at all? Used to gate the full-copy backfill.
pub fn has_stub_rows(state: &State, mapping_id: &str) -> bool {
    state
        .store
        .seen_for_mapping(mapping_id)
        .map(|rows| rows.iter().any(|r| !r.stored_full))
        .unwrap_or(false)
}

/// The role a mirror's OWNING account plays. Kept here so the two places that reason about
/// ownership agree.
pub fn is_owner_mapping(mapping: &Mapping) -> bool {
    mapping.role == Role::Owner
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_map_to_the_extension_immich_types_by() {
        assert_eq!(ext_for_content_type("image/jpeg"), Some("jpg"));
        assert_eq!(ext_for_content_type("video/mp4"), Some("mp4"));
        // A charset parameter must not defeat the match.
        assert_eq!(ext_for_content_type("image/jpeg; charset=binary"), Some("jpg"));
        assert_eq!(ext_for_content_type("application/octet-stream"), None);
        assert_eq!(ext_for_content_type(""), None);
    }

    #[test]
    fn the_video_prefix_guard_is_twice_what_we_ask_for() {
        // We ask for 2 MiB and refuse anything past 4 MiB, so a peer that ignores the range costs a
        // failed ref rather than our heap.
        assert_eq!(VIDEO_PREFIX_BYTES, 2 * 1024 * 1024);
        assert_eq!(VIDEO_PREFIX_GUARD, 2 * VIDEO_PREFIX_BYTES);
    }

    #[test]
    fn the_full_copy_cap_is_a_bound_not_a_policy() {
        assert_eq!(MAX_FULL_BYTES, 256 * 1024 * 1024);
    }

    #[test]
    fn the_stub_jpeg_decodes_to_a_real_jpeg() {
        let stub = stub_jpeg();
        assert!(stub.len() > 100, "{} bytes", stub.len());
        assert_eq!(&stub[..2], &[0xff, 0xd8], "SOI");
        assert_eq!(&stub[stub.len() - 2..], &[0xff, 0xd9], "EOI");
    }
}
