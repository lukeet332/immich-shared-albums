//! examples/probe.rs — one wire request from inside the rig's network, for the assertion suite.
//! The suite runs on the host, which cannot dial container IPs; this runs via
//! `docker run --network isa-demo` (built by run-mock-e2e.sh, extracted to target/probe) and
//! prints the result as JSON on stdout.
//!
//! argv[1] = JSON { keys:{pub,priv}, peerPub, addrs:[...], path, body?, range?, wantBytes?, bodyPad? }
//! Answers `{status, json}` — or `{status, bytesLength}` when the job asks for bytes.
//!
//! This speaks the SAME wire as the sidecar, using the crate's own framing: an assertion suite's
//! wire client is not pretending to be a second implementation, it is the protocol the product
//! serves, driven from outside the product's process.
use immich_shared_albums::p2p::frame::{frame, read_frame, HEADER_FRAME_LIMIT};
use immich_shared_albums::protocol::PROTOCOL_ALPN;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};
use serde_json::{json, Value};
use std::time::Duration;

/// Reaching a peer is a few seconds or it is not there (src/p2p/transport.rs's own budget).
const DIAL_DEADLINE: Duration = Duration::from_secs(10);
/// A JSON answer is bounded like the sidecar's own reads.
const JSON_READ_LIMIT: usize = 64 * 1024 * 1024;

fn main() {
    let job: Value = serde_json::from_str(
        std::env::args().nth(1).as_deref().unwrap_or("{}"),
    )
    .expect("the probe takes one JSON job");
    let outcome = tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(async move { run(&job).await });
    println!(
        "{}",
        serde_json::to_string(&outcome).expect("the answer is JSON")
    );
}

async fn run(job: &Value) -> Value {
    match drive(job).await {
        Ok(answer) => answer,
        Err(e) => json!({ "status": 0, "json": null, "error": e }),
    }
}

async fn drive(job: &Value) -> Result<Value, String> {
    let priv_b64 = job
        .pointer("/keys/priv")
        .and_then(|v| v.as_str())
        .ok_or("the job carries no identity")?;
    let secret_bytes = URL_SAFE_NO_PAD
        .decode(priv_b64)
        .map_err(|e| format!("bad identity key: {e}"))?;
    let secret = SecretKey::from_bytes(
        secret_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "the identity key is not 32 bytes")?,
    );

    let relay_off = std::env::var("RELAY").as_deref() == Ok("off");
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(secret)
        .alpns(vec![PROTOCOL_ALPN.to_vec()]);
    if !relay_off {
        builder = builder.relay_mode(RelayMode::Default);
    }
    let endpoint = builder
        .bind()
        .await
        .map_err(|e| format!("cannot bind endpoint: {e}"))?;

    let peer_pub = job
        .get("peerPub")
        .and_then(|v| v.as_str())
        .ok_or("the job carries no peer key")?;
    let peer_id = immich_shared_albums::p2p::transport::endpoint_id(peer_pub)?;
    let mut addr = EndpointAddr::new(peer_id);
    let hints: Vec<std::net::SocketAddr> = job
        .get("addrs")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter_map(|s| s.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    if !hints.is_empty() {
        addr = addr.with_addrs(hints.into_iter().map(iroh::TransportAddr::Ip));
    }

    let conn = tokio::time::timeout(DIAL_DEADLINE, endpoint.connect(addr, PROTOCOL_ALPN))
        .await
        .map_err(|_| "dialling the peer timed out".to_string())?
        .map_err(|e| format!("dialling the peer failed: {e}"))?;

    let header = json!({ "path": job.get("path"), "range": job.get("range") });
    // Large bodies are synthesised HERE: passing megabytes through docker's argv hits E2BIG — the
    // over-limit checks exist to prove the sidecar ANSWERS a too-big body (413) rather than dying.
    let body = match job.get("bodyPad").and_then(|v| v.as_u64()) {
        Some(pad) => serde_json::to_vec(&json!({ "pad": "x".repeat(pad as usize) }))
            .expect("a padded body is JSON"),
        None => job
            .get("body")
            .map(|b| serde_json::to_vec(b).expect("body is JSON"))
            .unwrap_or_default(),
    };

    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    send.write_all(&frame(&serde_json::to_vec(&header).expect("header is JSON")))
        .await
        .map_err(|e| e.to_string())?;
    send.write_all(&frame(&body)).await.map_err(|e| e.to_string())?;
    send.finish().map_err(|e| e.to_string())?;

    let head_bytes = read_frame(&mut recv, HEADER_FRAME_LIMIT)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|over| format!("response header frame of {} bytes is over the limit", over.declared))?;
    let head: Value = serde_json::from_slice(&head_bytes).map_err(|e| format!("bad response header: {e}"))?;
    let status = head.get("status").and_then(|s| s.as_u64()).unwrap_or(0) as u16;

    if job.get("wantBytes").and_then(|v| v.as_bool()).unwrap_or(false) {
        let mut bytes_length: usize = 0;
        let mut chunk = vec![0u8; 256 * 1024];
        while let Some(n) = recv.read(&mut chunk).await.map_err(|e| e.to_string())? {
            bytes_length += n;
        }
        return Ok(json!({ "status": status, "bytesLength": bytes_length }));
    }

    let mut rest = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    while let Some(n) = recv.read(&mut chunk).await.map_err(|e| e.to_string())? {
        rest.extend_from_slice(&chunk[..n]);
        if rest.len() > JSON_READ_LIMIT {
            return Err("response body exceeded the JSON limit".to_string());
        }
    }
    let parsed = if rest.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&rest).map_err(|e| format!("bad response body: {e}"))?
    };
    Ok(json!({ "status": status, "json": parsed }))
}
