//! web/upgrade.rs — protocol upgrades (websockets), proxied at the socket level. See ARCHITECTURE.md.
//!
//! Separate from `passthrough` on purpose: that path speaks request/response through a pooled HTTP
//! client, and an upgrade is neither. This is what makes the sidecar viable as the SINGLE front for
//! Immich — one reverse-proxy route instead of three path-matched ones in a required order. Immich
//! uses websockets for live web updates, so without this the web app silently loses them.

use crate::config::{cfg, ROUTE_PREFIX};
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How long the upstream has to answer the handshake before the socket is given up on.
const HANDSHAKE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Is this request asking to leave HTTP behind?
pub fn is_upgrade(headers: &HeaderMap) -> bool {
    let connection_says_upgrade = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("upgrade"))
        .unwrap_or(false);
    connection_says_upgrade && headers.contains_key(header::UPGRADE)
}

/// What the upstream answered with, once its head has been read.
struct UpstreamAnswer {
    status: StatusCode,
    headers: HeaderMap,
    /// Bytes already read PAST the head — the first frame, when the upstream was quick. They belong
    /// to the byte pipe and would truncate the stream if they were dropped.
    rest: Vec<u8>,
}

/// Pipe an upgrade straight through to Immich.
///
/// The handshake is REPLAYED, header for header, because the answer depends on it: the client's
/// `Sec-WebSocket-Key` is hashed into the `Sec-WebSocket-Accept` the browser checks, so a rewritten or
/// dropped header reads as a refused connection. Everything after the head is a byte pipe in both
/// directions — a websocket is not framed by anything this sidecar has any business understanding.
pub async fn proxy_upgrade(req: Request) -> Response {
    if req.uri().path().starts_with(ROUTE_PREFIX) {
        // Nothing under our own prefix speaks a websocket. Refuse rather than open a socket.
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((host, port)) = upstream_host_port() else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(mut upstream) = tokio::net::TcpStream::connect((host.as_str(), port)).await else {
        crate::log!("websocket proxy: cannot reach the upstream at {host}:{port}");
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let _ = upstream.set_nodelay(true);

    // The client's side of the upgraded connection, taken before anything is written upstream so a
    // request that cannot be upgraded never opens one.
    let Some(on_upgrade) = req.extensions().get::<hyper::upgrade::OnUpgrade>().cloned() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if upstream.write_all(request_head(&req).as_bytes()).await.is_err() {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let Some(answer) = read_answer(&mut upstream, &host, port).await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };

    if answer.status != StatusCode::SWITCHING_PROTOCOLS {
        // Immich refused the upgrade. Its own answer is passed on as it stands, so a client sees the
        // status and headers the server wrote rather than an invented failure.
        let rest = answer.rest;
        let body = Body::from_stream(futures_lite::stream::unfold(
            (upstream, rest),
            |(mut upstream, pending)| async move {
                if !pending.is_empty() {
                    return Some((Ok::<_, std::io::Error>(pending), (upstream, Vec::new())));
                }
                let mut chunk = vec![0u8; 16 * 1024];
                match upstream.read(&mut chunk).await {
                    Ok(0) | Err(_) => None,
                    Ok(n) => {
                        chunk.truncate(n);
                        Some((Ok(chunk), (upstream, Vec::new())))
                    }
                }
            },
        ));
        let mut response = Response::new(body);
        *response.status_mut() = answer.status;
        *response.headers_mut() = answer.headers;
        return response;
    }

    // hyper completes the upgrade on the strength of THIS response, so it has to carry the upstream's
    // own handshake headers: `Sec-WebSocket-Accept` is what the caller compares.
    tokio::spawn(async move {
        let Ok(client) = on_upgrade.await else { return };
        // `Upgraded` speaks hyper's IO traits; `TokioIo` is the adapter that makes it a tokio stream.
        // The upstream socket is already tokio's, so it is NOT wrapped.
        let mut client = hyper_util::rt::TokioIo::new(client);
        let mut upstream = upstream;
        if !answer.rest.is_empty() && client.write_all(&answer.rest).await.is_err() {
            return;
        }
        if let Err(e) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
            crate::trace!("websocket closed: {e}");
        }
    });
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    *response.headers_mut() = answer.headers;
    response
}

/// Read the upstream's response head, leaving everything after it in `rest`.
async fn read_answer(
    upstream: &mut tokio::net::TcpStream,
    host: &str,
    port: u16,
) -> Option<UpstreamAnswer> {
    let mut read_so_far = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = find_head_end(&read_so_far) {
            break at;
        }
        match tokio::time::timeout(HANDSHAKE_DEADLINE, upstream.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) => {
                crate::log!("websocket proxy: no handshake answer from {host}:{port}");
                return None;
            }
            Ok(Ok(n)) => read_so_far.extend_from_slice(&chunk[..n]),
            Ok(Err(e)) => {
                crate::log!("websocket proxy: {e}");
                return None;
            }
        }
    };
    let text = String::from_utf8_lossy(&read_so_far[..head_end]).to_string();
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .and_then(|code| StatusCode::from_u16(code).ok())?;
    let mut headers = HeaderMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            if let (Ok(name), Ok(value)) = (
                header::HeaderName::from_bytes(name.trim().as_bytes()),
                HeaderValue::from_str(value.trim()),
            ) {
                headers.append(name, value);
            }
        }
    }
    Some(UpstreamAnswer { status, headers, rest: read_so_far[head_end..].to_vec() })
}

/// The request line and headers, exactly as the client sent them.
///
/// Written from the parsed map rather than from raw bytes: an HTTP/1.1 header map preserves the
/// VALUES verbatim, which is what the handshake depends on, and the request target, which is what
/// routes it at Immich.
fn request_head(req: &Request) -> String {
    let method = req.method().as_str();
    let target = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let mut out = format!("{method} {target} HTTP/1.1\r\n");
    for (name, value) in req.headers() {
        if let Ok(value) = value.to_str() {
            out.push_str(&format!("{}: {value}\r\n", name.as_str()));
        }
    }
    out.push_str("\r\n");
    out
}

/// Where the upstream answers, from `ISA_IMMICH_URL`. Plain TCP, as the TypeScript does — a websocket
/// to an https upstream is not carried by either implementation.
fn upstream_host_port() -> Option<(String, u16)> {
    let uri: Uri = cfg().immich_url.parse().ok()?;
    let host = uri.host()?.to_string();
    let default_port = if uri.scheme_str() == Some("https") { 443 } else { 80 };
    Some((host, uri.port_u16().unwrap_or(default_port)))
}

/// The offset just past the blank line that ends a response head.
fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|w| w == b"\r\n\r\n").map(|at| at + 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upgrade_is_recognised_by_both_headers_together() {
        let mut headers = HeaderMap::new();
        assert!(!is_upgrade(&headers), "a plain request is not an upgrade");
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        assert!(!is_upgrade(&headers), "Connection alone is not enough");
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        assert!(is_upgrade(&headers));
        // Case is not the client's to get right: `keep-alive, Upgrade` is what a browser sends.
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
        assert!(is_upgrade(&headers));
    }

    #[test]
    fn the_head_is_terminated_at_its_blank_line() {
        assert_eq!(find_head_end(b"HTTP/1.1 101 x\r\n\r\nbody"), Some(18));
        assert_eq!(find_head_end(b"HTTP/1.1 101 x\r\n"), None, "an unfinished head has no end");
    }

    #[test]
    fn the_upstream_address_survives_a_url_with_no_port() {
        let uri: Uri = "http://immich-server:2283".parse().unwrap();
        assert_eq!(uri.host(), Some("immich-server"));
        assert_eq!(uri.port_u16(), Some(2283));
        let uri: Uri = "http://immich".parse().unwrap();
        assert_eq!(uri.host(), Some("immich"));
        assert_eq!(uri.port_u16(), None);
    }
}
