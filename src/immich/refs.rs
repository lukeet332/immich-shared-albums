/** immich/refs.rs — turning local assets into the refs that travel on the wire. See ARCHITECTURE.md. */
use crate::config::{cfg, is_utility_email, person_name};
use crate::immich::client::USERS;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The two facts this module needs from the ledger, injected rather than reached for.
///
/// Reading them from a global made every function here untestable without booting a whole sidecar,
/// and the checksum rule is subtle enough to deserve its own tests: a materialised proxy keeps its
/// SOURCE photo's checksum, because that — not the local re-encode — is what identifies the photo
/// to a peer.
#[derive(Clone, Copy)]
/// `Send + Sync` on the trait objects matters: a `Ledger` is held across awaits in the sync loops,
/// and a bare `dyn Fn` is neither, so the whole loop future would stop being `Send`.
pub struct Ledger<'a> {
    /// The checksum that travels for a local asset, given the asset's own checksum as a fallback.
    pub wire_checksum: &'a (dyn Fn(&str, &str) -> String + Send + Sync),
    /// Whether this sidecar put this bot-owned asset here, so it is ours to offer onward.
    pub has_ledger_row: &'a (dyn Fn(&str) -> bool + Send + Sync),
}

impl Ledger<'_> {
    /// A ledger with no history: every checksum is the local one and no bot asset is ours. For
    /// tests and for the first push of a fresh install.
    pub fn empty() -> Ledger<'static> {
        Ledger {
            wire_checksum: &|_, local| local.to_string(),
            has_ledger_row: &|_| false,
        }
    }
}

/// One photo or video, as a peer sees it. This is the wire contract — every optional field must
/// stay omittable, because adding one is never a breaking change but REMOVING one is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssetRef {
    #[serde(rename = "originAsset")]
    pub origin_asset: String,
    pub checksum: String,
    /// Declared and documented but never produced: an absent value means the default `sha1-b64`.
    #[serde(
        rename = "checksumAlg",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub checksum_alg: Option<String>,
    pub contributor: Contributor,
    pub kind: String,
    #[serde(rename = "takenAt", skip_serializing_if = "Option::is_none", default)]
    pub taken_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exif: Option<RefExif>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contributor {
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(
        rename = "originUserId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub origin_user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RefExif {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rating: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub height: Option<i64>,
}

/// The display dimensions Immich would lay the photo out at, or `None` when it has NOT MEASURED the
/// asset yet.
///
/// The distinction matters more than it looks: `None` is "wait", not "0×0". A photo mirrored before
/// Immich's metadata job runs would become a square stub forever if this answered zeroes, so the
/// push and the manifest both hold such an asset back until it has a real shape.
pub fn display_dims(exif: Option<&Value>) -> (Option<i64>, Option<i64>) {
    let Some(exif) = exif else {
        return (None, None);
    };
    let w = exif
        .get("exifImageWidth")
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0);
    let h = exif
        .get("exifImageHeight")
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0);
    let (Some(w), Some(h)) = (w, h) else {
        return (None, None);
    };
    // Orientations 5-8 transpose the image, so the LAYOUT dims are swapped.
    let orientation = exif
        .get("orientation")
        .and_then(|v| v.as_str())
        .unwrap_or("1");
    if matches!(orientation, "5" | "6" | "7" | "8") {
        (Some(h), Some(w))
    } else {
        (Some(w), Some(h))
    }
}

pub fn shape_is_known(exif: Option<&Value>) -> bool {
    let (w, h) = display_dims(exif);
    w.is_some() && h.is_some()
}

/// Strip the credit line a previous hop appended, so a relayed photo's description does not grow a
/// "Shared by …" per hop.
fn without_credit_line(description: Option<&str>) -> Option<String> {
    let text = description?;
    let stripped = text.split("\n\nShared by ").next().unwrap_or(text).trim();
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

/// The person a photo came from, as the wire names them.
///
/// A bot account's local name is decorated ("Nan (via B server)"), but the name that travels must
/// be the PERSON's — the decoration accumulating one layer per relay hop is exactly what
/// `person_name` exists to prevent. A human's own name travels verbatim.
pub fn contributor_for(asset: &Value, users: &USERS) -> Contributor {
    let origin_user_id = asset
        .get("ownerId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let owner = origin_user_id.as_deref().and_then(|id| users.get(id));
    let display_name = match owner {
        Some(user) if user.utility => {
            let stripped = person_name(Some(&user.name));
            if stripped.is_empty() {
                cfg().name.clone()
            } else {
                stripped
            }
        }
        Some(user) => user.name.clone(),
        None => cfg().name.clone(),
    };
    Contributor {
        display_name,
        origin_user_id,
    }
}

pub fn asset_to_ref(asset: &Value, users: &USERS, ledger: Ledger<'_>) -> Option<AssetRef> {
    let id = asset.get("id").and_then(|v| v.as_str())?.to_string();
    let kind = match asset
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("IMAGE")
    {
        "VIDEO" => "video",
        _ => "image",
    };
    let local_checksum = asset
        .get("checksum")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    // The ledger's SOURCE checksum wins: a materialised proxy was re-encoded locally, and only the
    // origin's own checksum identifies the photo to a peer.
    let checksum = (ledger.wire_checksum)(&id, local_checksum);

    // The exif BLOCK is the real one — a hidden photo still has a rating and a place. Only the
    // dimensions go through `measured_exif`, which is exactly what the TypeScript does: hiding
    // reproduces "Immich has not measured this yet", not "this photo knows nothing".
    let exif = asset.get("exifInfo");
    let (width, height) = display_dims(measured_exif(asset));
    let exif_out = RefExif {
        latitude: exif
            .and_then(|e| e.get("latitude"))
            .and_then(|v| v.as_f64()),
        longitude: exif
            .and_then(|e| e.get("longitude"))
            .and_then(|v| v.as_f64()),
        description: without_credit_line(
            exif.and_then(|e| e.get("description"))
                .and_then(|v| v.as_str()),
        ),
        rating: exif
            .and_then(|e| e.get("rating"))
            .and_then(|v| v.as_i64())
            .filter(|r| *r != 0),
        width,
        height,
    };
    let has_exif = exif_out != RefExif::default();

    Some(AssetRef {
        origin_asset: id,
        checksum,
        checksum_alg: None,
        contributor: contributor_for(asset, users),
        kind: kind.to_string(),
        taken_at: asset
            .get("fileCreatedAt")
            .or_else(|| asset.get("localDateTime"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        exif: if has_exif { Some(exif_out) } else { None },
    })
}

/// Human-owned photos only: a proxy is excluded because it IS a peer's photo, and offering it back
/// would relay someone their own image under our name.
pub fn is_offerable(asset: &Value, users: &USERS, ledger: Ledger<'_>) -> bool {
    let kind = asset
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("IMAGE");
    if kind != "IMAGE" && kind != "VIDEO" {
        return false;
    }
    let owner = asset.get("ownerId").and_then(|v| v.as_str());
    // An owner we cannot identify is not one we can attribute; the caller refreshes the user cache
    // and tries once more before giving up on it.
    let Some(owner) = owner else { return false };
    let Some(user) = users.get(owner) else {
        return false;
    };
    if !user.utility {
        return true;
    }
    // A bot-owned asset is only ours to offer when the ledger says this sidecar put it there.
    (ledger.has_ledger_row)(asset.get("id").and_then(|v| v.as_str()).unwrap_or(""))
}

/// What Immich knows about this photo, unless a rig is pretending its metadata job has not run.
///
/// ONE place decides this, because it has to be the same answer everywhere: a ref that carries
/// dimensions while the offer set says the shape is unknown is a contradiction, and it is the
/// offer set that keeps a half-measured photo from reaching a peer as a square stub.
pub fn measured_exif(asset: &Value) -> Option<&Value> {
    let id = asset.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if crate::immich::unmeasured::is_hidden_as_unmeasured(id) {
        return None;
    }
    asset.get("exifInfo")
}

/// Split what can be offered from what must wait for Immich to measure it. Both sides are ASSETS,
/// not refs: the caller converts at the end, so a filter that only needs identity (has this mapping
/// sent it yet?) does not pay for building a ref it may throw away.
pub fn partition_offerable(
    assets: &[Value],
    users: &USERS,
    ledger: Ledger<'_>,
) -> (Vec<Value>, Vec<Value>) {
    let mut offer = Vec::new();
    let mut awaiting = Vec::new();
    for asset in assets {
        if !is_offerable(asset, users, ledger) {
            continue;
        }
        if shape_is_known(measured_exif(asset)) {
            offer.push(asset.clone());
        } else {
            awaiting.push(asset.clone());
        }
    }
    (offer, awaiting)
}

/// The manifest a peer pulls: what this household offers, as refs.
pub fn build_manifest(assets: &[Value], users: &USERS, ledger: Ledger<'_>) -> Vec<AssetRef> {
    partition_offerable(assets, users, ledger)
        .0
        .iter()
        .filter_map(|asset| asset_to_ref(asset, users, ledger))
        .collect()
}

/// What is shareable with the peer behind `mapping_id`: everything offerable MINUS what this mapping
/// has already sent.
///
/// A photo we already sent is not waiting on us, however shapeless it looks — an unshaped stub from
/// an older peer, or one materialised before the shape rule existed, would otherwise hold the
/// mapping's version cursor for ever and cost an album read every cycle to re-decide the same thing.
pub fn shareable_assets(
    state: &crate::state::State,
    assets: &[Value],
    users: &USERS,
    ledger: Ledger<'_>,
    mapping_id: &str,
) -> (Vec<Value>, usize) {
    let (offer, awaiting) = partition_offerable(assets, users, ledger);
    let not_sent_yet = |asset: &Value| {
        let id = asset.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let local = asset
            .get("checksum")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        // The SOURCE checksum is what the ledger holds, so the lookup must use the same rule.
        let checksum = (ledger.wire_checksum)(id, local);
        !state.store.seen_has(mapping_id, &checksum).unwrap_or(false)
    };
    let refs: Vec<Value> = offer.into_iter().filter(not_sent_yet).collect();
    let awaiting_count = awaiting.iter().filter(|a| not_sent_yet(a)).count();
    (refs, awaiting_count)
}

/// Does this email belong to one of our bot accounts? Re-exported so callers do not re-derive it.
pub fn is_bot_email(email: Option<&str>) -> bool {
    is_utility_email(email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn install_config() {
        crate::config::install_test_config();
    }

    fn exif(w: i64, h: i64, orientation: &str) -> Value {
        json!({ "exifImageWidth": w, "exifImageHeight": h, "orientation": orientation })
    }

    #[test]
    fn display_dims_are_the_layout_dims_not_the_stored_ones() {
        assert_eq!(
            display_dims(Some(&exif(4000, 3000, "1"))),
            (Some(4000), Some(3000))
        );
        // Orientations 5-8 transpose: a photo stored 4000x3000 with orientation 6 LAYS OUT 3000x4000.
        for o in ["5", "6", "7", "8"] {
            assert_eq!(
                display_dims(Some(&exif(4000, 3000, o))),
                (Some(3000), Some(4000)),
                "orientation {o}"
            );
        }
        for o in ["1", "2", "3", "4"] {
            assert_eq!(
                display_dims(Some(&exif(4000, 3000, o))),
                (Some(4000), Some(3000)),
                "orientation {o}"
            );
        }
    }

    #[test]
    #[allow(non_snake_case)] // the CAPITALS carry the load-bearing word
    fn an_unmeasured_asset_is_UNKNOWN_not_zero_by_zero() {
        // This is the distinction that keeps a mirror from becoming a square stub forever.
        assert_eq!(display_dims(None), (None, None));
        assert_eq!(display_dims(Some(&json!({}))), (None, None));
        assert_eq!(
            display_dims(Some(&json!({"exifImageWidth": 0, "exifImageHeight": 0}))),
            (None, None)
        );
        assert_eq!(
            display_dims(Some(&json!({"exifImageWidth": 100}))),
            (None, None),
            "one side is not a shape"
        );
        assert!(!shape_is_known(Some(&json!({"exifImageWidth": 100}))));
        assert!(shape_is_known(Some(&exif(1, 1, "1"))), "1x1 IS a shape");
    }

    #[test]
    fn the_credit_line_is_stripped_so_it_cannot_stack_per_hop() {
        assert_eq!(
            without_credit_line(Some("Holiday\n\nShared by Nan")),
            Some("Holiday".into())
        );
        assert_eq!(
            without_credit_line(Some("Just a caption")),
            Some("Just a caption".into())
        );
        assert_eq!(without_credit_line(Some("")), None);
        assert_eq!(without_credit_line(None), None);
    }

    #[test]
    fn an_asset_ref_omits_every_absent_optional_field() {
        install_config();
        let users = USERS::default();
        let asset = json!({
            "id": "a1", "type": "IMAGE", "checksum": "sum", "ownerId": "u1",
            "fileCreatedAt": "2026-01-01T00:00:00.000Z"
        });
        let reference = asset_to_ref(&asset, &users, Ledger::empty()).expect("a ref");
        let wire = serde_json::to_string(&reference).unwrap();
        // Absent means absent — the peer reads the protocol's defaults.
        assert!(!wire.contains("checksumAlg"), "{wire}");
        assert!(!wire.contains("exif"), "{wire}");
        assert!(wire.contains("\"originAsset\":\"a1\""));
        assert!(wire.contains("\"kind\":\"image\""));
    }

    #[test]
    fn a_video_is_kind_video_and_anything_else_is_an_image() {
        install_config();
        let users = USERS::default();
        let video = json!({"id": "v1", "type": "VIDEO", "checksum": "s", "ownerId": "u1"});
        assert_eq!(
            asset_to_ref(&video, &users, Ledger::empty()).unwrap().kind,
            "video"
        );
        let image = json!({"id": "i1", "type": "IMAGE", "checksum": "s", "ownerId": "u1"});
        assert_eq!(
            asset_to_ref(&image, &users, Ledger::empty()).unwrap().kind,
            "image"
        );
    }

    #[test]
    fn a_zero_rating_is_absent_rather_than_zero() {
        install_config();
        let users = USERS::default();
        let asset = json!({
            "id": "a1", "type": "IMAGE", "checksum": "s", "ownerId": "u1",
            "exifInfo": {"rating": 0, "exifImageWidth": 10, "exifImageHeight": 10}
        });
        let reference = asset_to_ref(&asset, &users, Ledger::empty()).unwrap();
        assert_eq!(reference.exif.unwrap().rating, None);
    }

    #[test]
    fn an_asset_with_no_owner_is_not_offerable() {
        // Attribution needs an owner id; without one we cannot name who the photo belongs to.
        let users = USERS::default();
        let asset = json!({"id": "a1", "type": "IMAGE", "checksum": "s"});
        assert!(!is_offerable(&asset, &users, Ledger::empty()));
    }
}
