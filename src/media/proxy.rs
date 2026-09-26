/** media/proxy.rs — the hotlink byte path: true pixels resolved locally or chained to the owner over iroh. See ARCHITECTURE.md. */
use crate::immich::client::{Auth, Client};
use crate::p2p::entitlement::peer_may_read;
use crate::p2p::transport::{transport, ByteStream, PeerAnswer, PeerBody};
use crate::state::State;
use futures_lite::StreamExt;
use std::collections::HashMap;

/// The only headers a byte route carries through. Framing headers describe a hop's encoding, which
/// this proxy re-frames, so forwarding them corrupts the body.
pub const BYTE_HEADERS: [&str; 4] = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
];

/// One shape for bytes from anywhere — a local Immich fetch or a peer stream.
pub struct ByteSource {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: PeerBody,
}

fn collect_byte_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for name in BYTE_HEADERS {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            out.insert(name.to_string(), value.to_string());
        }
    }
    out
}

/// Resolve true bytes for any local asset.
///
/// Our own photos come from the local Immich; a PROXY (a ledger row with an origin) chains the
/// request to the owner over iroh, which is how a relayed photo's pixels stream
/// `D <- origin <- contributor`. The Range rides the frame unchanged.
///
/// Every failure falls through to the LOCAL answer, which for a stub is the stub itself: a dead
/// owner degrades a shared tile rather than breaking the page.
pub async fn fetch_true_bytes(
    state: &State,
    client: &Client,
    asset_id: &str,
    kind: &str,
    range: Option<&str>,
) -> ByteSource {
    let entry = state.store.ledger_with_origin(asset_id).ok().flatten();
    if let Some(entry) = entry.filter(|e| !e.stored_full) {
        // A stored-FULL copy holds real bytes locally, so it is served below instead of chained:
        // only genuine stubs need the peer fetch.
        // ONE guard, taken once. `collections()` hands back a std MutexGuard, and a second call
        // while the first is alive is a self-deadlock, not a re-read — the peer lookup below needs
        // both halves of the same snapshot anyway.
        let peer = {
            let collections = state.collections();
            collections
                .mappings
                .iter()
                .find(|m| m.id == entry.mapping)
                .and_then(|m| {
                    collections
                        .peers
                        .iter()
                        .find(|p| p.pub_key == m.peer)
                        .cloned()
                })
        };
        if let Some(peer) = peer {
            if let Some(origin) = entry.origin_asset.as_deref() {
                if let Some(transport) = transport() {
                    let path = format!("/assets/{origin}/{kind}");
                    match transport
                        .byte_request(&peer, &path, range, Some(&entry.mapping))
                        .await
                    {
                        Ok((head, body)) if head.status < 400 => {
                            return ByteSource {
                                status: head.status,
                                headers: head.headers.unwrap_or_default(),
                                body: PeerBody::Bytes(body),
                            };
                        }
                        Ok((head, _)) => crate::log!(
                            "chained {kind} fetch failed ({}) — serving local stub",
                            head.status
                        ),
                        Err(e) => {
                            crate::log!("chained {kind} fetch error ({e}) — serving local stub")
                        }
                    }
                }
            }
        }
    }

    let path = match kind {
        "original" => format!("/assets/{asset_id}/original"),
        "playback" => format!("/assets/{asset_id}/video/playback"),
        _ => format!("/assets/{asset_id}/thumbnail?size=preview"),
    };
    let extra: Vec<(String, String)> = range
        .map(|r| vec![("Range".to_string(), r.to_string())])
        .unwrap_or_default();
    match client
        .request(reqwest::Method::GET, &path, &Auth::Admin, &extra)
        .await
    {
        Ok(response) => {
            let status = response.status().as_u16();
            let headers = collect_byte_headers(response.headers());
            // Streamed, never buffered: the local answer for a video prefix is megabytes.
            let stream: ByteStream = Box::pin(
                response
                    .bytes_stream()
                    .map(|chunk| chunk.map(|bytes| bytes.to_vec()).unwrap_or_default()),
            );
            ByteSource {
                status,
                headers,
                body: PeerBody::Stream(stream),
            }
        }
        // STATUS 0 is our own transport failure — nothing was asked of Immich, so nothing was
        // answered. Anything else is Immich's OWN answer and is passed through with its own status
        // and body: a photo has no `/video/playback`, and Immich says so. Replacing that with a
        // synthetic 502 tells the app the network broke when nothing did, and hides a 400 the app
        // knows how to handle behind one it does not.
        Err(e) if e.status != 0 => {
            let mut headers = HashMap::new();
            headers.insert("content-type".to_string(), "application/json".to_string());
            ByteSource {
                status: e.status,
                headers,
                body: PeerBody::Bytes(e.body.into_bytes()),
            }
        }
        Err(e) => ByteSource {
            status: 502,
            headers: HashMap::new(),
            body: PeerBody::Bytes(
                serde_json::json!({ "error": format!("the local Immich could not be read: {e}") })
                    .to_string()
                    .into_bytes(),
            ),
        },
    }
}

/// Enrolled AND on the list of things we offered them. Both, every time.
pub async fn serve_peer_bytes(
    state: &State,
    client: &Client,
    caller_pub: &str,
    asset_id: &str,
    kind: &str,
    range: Option<&str>,
) -> PeerAnswer {
    let known = state
        .collections()
        .peers
        .iter()
        .any(|p| p.pub_key == caller_pub);
    if !known {
        return json_answer(403, serde_json::json!({ "error": "unknown peer" }));
    }
    // The connection proved WHO is calling; this decides WHAT they may see. Without it, any
    // enrolled peer could read anything in the library it could name.
    if !peer_may_read(state, caller_pub, asset_id) {
        let name = state
            .collections()
            .peers
            .iter()
            .find(|p| p.pub_key == caller_pub)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        crate::log!(
            "byte read refused: \"{name}\" is not entitled to asset {}",
            &asset_id[..asset_id.len().min(8)]
        );
        return json_answer(403, serde_json::json!({ "error": "not shared with you" }));
    }
    let source = fetch_true_bytes(state, client, asset_id, kind, range).await;
    PeerAnswer {
        status: source.status,
        headers: Some(source.headers),
        body: source.body,
    }
}

fn json_answer(status: u16, value: serde_json::Value) -> PeerAnswer {
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    PeerAnswer {
        status,
        headers: Some(headers),
        body: PeerBody::Bytes(value.to_string().into_bytes()),
    }
}

/// The peer route path for a byte read, or `None` when the path is not one.
pub fn byte_route(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/assets/")?;
    let (asset_id, kind) = rest.split_once('/')?;
    if asset_id.is_empty() || !matches!(kind, "preview" | "original" | "playback") {
        return None;
    }
    Some((asset_id.to_string(), kind.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_byte_route_matches_exactly_three_kinds() {
        assert_eq!(
            byte_route("/assets/a1/preview"),
            Some(("a1".into(), "preview".into()))
        );
        assert_eq!(
            byte_route("/assets/a1/original"),
            Some(("a1".into(), "original".into()))
        );
        assert_eq!(
            byte_route("/assets/a1/playback"),
            Some(("a1".into(), "playback".into()))
        );
        // A THUMBNAIL is not a peer route: that is the app's own URL, served by the interceptor.
        assert_eq!(byte_route("/assets/a1/thumbnail"), None);
        assert_eq!(byte_route("/assets/a1"), None);
        assert_eq!(byte_route("/assets//preview"), None);
        assert_eq!(byte_route("/albums/a1/preview"), None);
        assert_eq!(byte_route("/assets/a1/../etc"), None);
    }

    #[test]
    fn only_the_four_byte_headers_are_carried_through() {
        // Framing headers describe a hop's own encoding; forwarding one re-frames a body twice.
        assert_eq!(BYTE_HEADERS.len(), 4);
        assert!(!BYTE_HEADERS.contains(&"transfer-encoding"));
        assert!(!BYTE_HEADERS.contains(&"content-encoding"));
        assert!(!BYTE_HEADERS.contains(&"set-cookie"));
    }
}
