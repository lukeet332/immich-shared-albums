/** web/interceptor.rs — the app-facing byte interceptor for proxy assets. See PORT.md. */
use crate::immich::access::creds_from_headers;
use crate::immich::client::{Auth, Client};
use crate::media::{cache, proxy};
use crate::p2p::transport::{transport, PeerBody};
use crate::state::State;
use axum::body::{Body as HttpBody, Bytes};
use futures_lite::StreamExt;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

/// Which of the app's own asset URLs was asked for. `/thumbnail` is the grid, `/original` the
/// viewer, `/video/playback` the transcoded stream.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Thumbnail,
    Original,
    Playback,
}

impl Kind {
    /// The name the PEER route uses. The app's URL and the wire route are not the same vocabulary:
    /// a thumbnail is fetched from its owner as a "preview".
    fn wire(self) -> &'static str {
        match self {
            Kind::Thumbnail => "preview",
            Kind::Original => "original",
            Kind::Playback => "playback",
        }
    }
}

/// The app's asset URLs this module serves. Deliberately exact: a fourth kind must be added here
/// rather than silently matched by a looser pattern.
pub fn interceptor_route(path: &str) -> Option<(&str, Kind)> {
    let rest = path.strip_prefix("/api/assets/")?;
    let (asset_id, tail) = rest.split_once('/')?;
    if asset_id.is_empty() {
        return None;
    }
    let kind = match tail {
        "thumbnail" => Kind::Thumbnail,
        "original" => Kind::Original,
        "video/playback" => Kind::Playback,
        _ => return None,
    };
    Some((asset_id, kind))
}

fn bytes_response(status: StatusCode, headers: Vec<(String, String)>, body: Vec<u8>) -> Response {
    let mut builder = Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    builder.body(HttpBody::from(body)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn empty_status(status: u16) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    Response::builder().status(code).body(HttpBody::empty()).unwrap_or_else(|_| code.into_response())
}

/// Serve the app's asset URL from the OWNER when the local row is only a stub.
///
/// `None` means "not ours": no ledger row with an origin, or a stored-FULL copy that holds its own
/// real bytes, or any failure — Immich then answers with what it has, which is the stub. That
/// fail-open direction is the whole point: a dead owner degrades a tile, it does not break a page.
pub async fn serve(
    state: &State,
    client: &Client,
    path: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    range: Option<&str>,
) -> Option<Response> {
    let (asset_id, kind) = interceptor_route(path)?;
    let entry = state.store.ledger_with_origin(asset_id).ok().flatten()?;
    if entry.stored_full {
        return None;
    }

    // Authorise with the caller's OWN credential, and forward the share link's `key` too, so Immich
    // decides with the link's own authority (its expiry, its password) instead of 401ing a visitor
    // who is legitimately looking at a stub they were sent.
    let creds = creds_from_headers(headers);
    let auth = match &creds {
        Some(creds) => Auth::Creds(creds),
        // No credential at all: fall back to the household key, which answers 404 for an asset it
        // does not own rather than the caller's own 401. The probe below still decides.
        None => Auth::Admin,
    };
    // A share link's own authority, forwarded so Immich decides with it rather than 401ing a visitor.
    let key = crate::web::query::param(query, "key");
    let probe = match &key {
        Some(key) => format!("/assets/{asset_id}?key={}", crate::web::query::urlencode(key)),
        None => format!("/assets/{asset_id}"),
    };
    match client.request(reqwest::Method::GET, &probe, &auth, &[]).await {
        Ok(_) => {}
        // Immich's own answer — a 401 for an anonymous visitor, a 403 for a link that expired, a
        // 404 for one withdrawn. Passed through so the app shows what Immich would have.
        Err(e) if e.status != 0 => return Some(empty_status(e.status)),
        Err(_) => return Some(empty_status(502)),
    }

    let origin = entry.origin_asset.clone().unwrap_or_default();
    if kind == Kind::Thumbnail {
        if let Some(bytes) = cache::cache_read(&origin).await {
            return Some(bytes_response(
                StatusCode::OK,
                preview_header_list("HIT", bytes.len(), None),
                bytes,
            ));
        }
        if let Some(bytes) = from_owner(state, &entry.mapping, &origin).await {
            cache::cache_write(&origin, &bytes).await;
            return Some(bytes_response(
                StatusCode::OK,
                preview_header_list("MISS", bytes.len(), None),
                bytes,
            ));
        }
        // The owner is unreachable and nothing is cached: the LOCAL stub thumbnail, which is the
        // blurred placeholder the row was created with. Never cached — it is not the true bytes,
        // and caching it would poison every later view.
        let stub = format!("/assets/{asset_id}/thumbnail?size=preview");
        if let Ok(response) = client.request(reqwest::Method::GET, &stub, &Auth::Admin, &[]).await {
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            if let Ok(bytes) = response.bytes().await {
                let bytes = bytes.to_vec();
                return Some(bytes_response(
                    StatusCode::OK,
                    preview_header_list("BYPASS", bytes.len(), Some(&content_type)),
                    bytes,
                ));
            }
        }
        return Some(empty_status(503));
    }

    let source = proxy::fetch_true_bytes(state, client, asset_id, kind.wire(), range).await;
    let mut out: Vec<(String, String)> = source.headers.into_iter().collect();
    out.push(("cache-control".to_string(), "private, max-age=604800, immutable".to_string()));
    // An ORIGINAL can be megabytes (a video prefix especially), so the local answer arrives as a
    // stream and is passed straight through. Buffering it here to serve it would defeat the reason
    // `fetch_true_bytes` streams at all.
    let body = match source.body {
        PeerBody::Bytes(bytes) => HttpBody::from(bytes),
        PeerBody::Stream(stream) => HttpBody::from_stream(
            stream.map(|chunk| Ok::<_, std::io::Error>(Bytes::from(chunk))),
        ),
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(source.status).unwrap_or(StatusCode::OK));
    for (name, value) in out {
        builder = builder.header(name, value);
    }
    Some(
        builder
            .body(body)
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    )
}

/// A preview's headers. Advertised as immutable because a photo's bytes never change, and tagged
/// with where the bytes came from: HIT is the cache, MISS is the owner, BYPASS is the local stub.
fn preview_header_list(
    cache_state: &'static str,
    length: usize,
    content_type: Option<&str>,
) -> Vec<(String, String)> {
    vec![
        ("content-type".to_string(), content_type.unwrap_or("image/jpeg").to_string()),
        ("cache-control".to_string(), "private, max-age=604800, immutable".to_string()),
        ("x-cache".to_string(), cache_state.to_string()),
        ("content-length".to_string(), length.to_string()),
    ]
}

/// Ask the owner for the preview, bounded. The 32 MiB guard is stricter than the transport's own
/// 64 MiB ceiling because a preview is ~100KB: anything near this is not one, and buffering it
/// would cost the household a page load to serve one broken tile.
const PREVIEW_LIMIT: usize = 32 * 1024 * 1024;

async fn from_owner(state: &State, mapping_id: &str, origin: &str) -> Option<Vec<u8>> {
    let peer = {
        let collections = state.collections();
        collections
            .mappings
            .iter()
            .find(|m| m.id == mapping_id)
            .and_then(|m| collections.peers.iter().find(|p| p.pub_key == m.peer).cloned())
    }?;
    let transport = transport()?;
    let path = format!("/assets/{origin}/preview");
    match transport.byte_request(&peer, &path, None, None).await {
        Ok((head, body)) if head.status < 400 && body.len() <= PREVIEW_LIMIT => Some(body),
        Ok((_head, body)) if body.len() > PREVIEW_LIMIT => {
            crate::log!("preview from \"{}\" was {} bytes — refusing to buffer it", peer.name, body.len());
            None
        }
        Ok(_) => None,
        Err(e) => {
            crate::log!("preview fetch failed, serving stub: {e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_app_urls_are_intercepted() {
        assert_eq!(interceptor_route("/api/assets/a1/thumbnail"), Some(("a1", Kind::Thumbnail)));
        assert_eq!(interceptor_route("/api/assets/a1/original"), Some(("a1", Kind::Original)));
        assert_eq!(interceptor_route("/api/assets/a1/video/playback"), Some(("a1", Kind::Playback)));
        assert_eq!(interceptor_route("/api/assets/a1"), None);
        assert_eq!(interceptor_route("/api/assets/a1/thumb"), None);
        assert_eq!(interceptor_route("/api/assets//thumbnail"), None);
        assert_eq!(interceptor_route("/api/albums/a1/thumbnail"), None);
    }

    #[test]
    fn a_thumbnail_is_a_preview_on_the_wire() {
        // The app's vocabulary and the peer route's are not the same; getting this wrong asks a
        // peer for a route it does not serve.
        assert_eq!(Kind::Thumbnail.wire(), "preview");
        assert_eq!(Kind::Original.wire(), "original");
        assert_eq!(Kind::Playback.wire(), "playback");
    }

    #[test]
    fn the_preview_guard_is_stricter_than_the_transport_ceiling() {
        // A preview is ~100KB. The interceptor refuses well before the transport's blanket 64 MiB,
        // because buffering 32 MiB of "preview" is a page load spent on one broken tile.
        assert!(PREVIEW_LIMIT < crate::p2p::transport::BYTE_BODY_LIMIT);
    }
}
