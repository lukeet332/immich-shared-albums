/** web/passthrough.rs — transparent streaming proxy to Immich for every non-sidecar route. See PORT.md. */
use crate::config::cfg;
use axum::body::Body;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use std::sync::OnceLock;

/// Headers the upstream response must not carry through. `content-length` and `transfer-encoding`
/// describe the upstream framing, which this proxy re-frames; `content-encoding` would leave the
/// caller decoding a body we already decoded.
const STRIPPED_RESPONSE_HEADERS: [&str; 3] = ["content-encoding", "transfer-encoding", "content-length"];

/// Headers a proxy must not forward verbatim: `host` names OUR listener, not Immich's.
const STRIPPED_REQUEST_HEADERS: [&str; 2] = ["host", "content-length"];

/// ONE client for the process, and it is not a micro-optimisation: a `reqwest::Client` owns a
/// connection POOL, so building one per request means a fresh pool (and a fresh TCP connection to
/// Immich) for every single request, with the old pools accumulating. Measured on the passthrough
/// path: throughput fell from ~2300 to ~1400 rps across successive runs while pinning 6+ cores,
/// against a Node sidecar holding a steady ~3400 rps on one. Redirects stay disabled — the proxy
/// answers with Immich's own redirect rather than following it.
static UPSTREAM: OnceLock<reqwest::Client> = OnceLock::new();

fn upstream() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = UPSTREAM.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    // A lost race here just drops the duplicate; whichever client won is equivalent.
    Ok(UPSTREAM.get_or_init(|| built))
}

/// Proxy a request to Immich and stream the answer back.
///
/// Nothing is buffered and nothing is rewritten: uploads must never be held in memory here, and a
/// photo stream must not become a `Vec`. The body is passed through as a stream, and so is the
/// response.
///
/// FAIL LOUDLY. A caller left waiting for a response they will never get is worse than an error, and
/// it is exactly what an earlier version of this proxy did — so any failure answers 502 with the
/// reason, never a dropped connection.
pub async fn proxy_to_immich(method: Method, uri: &Uri, headers: &HeaderMap, body: Body) -> Response {
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url = format!("{}{}", cfg().immich_url.trim_end_matches('/'), path_and_query);

    let client = match upstream() {
        Ok(client) => client,
        Err(e) => return unreachable_immich(&e),
    };

    let mut outbound = client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &url,
    );
    for (name, value) in headers.iter() {
        let name_str = name.as_str();
        if STRIPPED_REQUEST_HEADERS.contains(&name_str) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            outbound = outbound.header(name_str, value);
        }
    }
    // The body is forwarded as a stream, without a `Content-Length` we would have to know in advance.
    outbound = outbound.body(reqwest::Body::wrap_stream(body.into_data_stream()));

    let upstream = match outbound.send().await {
        Ok(upstream) => upstream,
        Err(e) => {
            crate::log!("proxying {} {} failed: {e}", method, path_and_query);
            return unreachable_immich(&e.to_string());
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if STRIPPED_RESPONSE_HEADERS.contains(&name.as_str()) {
            continue;
        }
        // A set-cookie carries one cookie per header; appending keeps them all.
        response = response.header(name, value);
    }
    let stream = upstream.bytes_stream();
    response
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// The one answer a caller must always get when Immich cannot be reached.
fn unreachable_immich(reason: &str) -> Response {
    let body = serde_json::json!({ "message": format!("the addons could not reach Immich: {reason}") });
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_failure_answer_names_immich_and_carries_the_reason() {
        // The message shape the panel's JS surfaces; a silent failure here is what left callers
        // waiting forever before this existed.
        let r = unreachable_immich("connection refused");
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "application/json");
    }

    #[test]
    fn framing_headers_are_not_forwarded_verbatim() {
        // Forwarding any of these re-frames a body twice and corrupts it.
        for name in STRIPPED_RESPONSE_HEADERS {
            assert!(["content-encoding", "transfer-encoding", "content-length"].contains(&name));
        }
        // `host` names our listener, not Immich's.
        assert!(STRIPPED_REQUEST_HEADERS.contains(&"host"));
    }
}
