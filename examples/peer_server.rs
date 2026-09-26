// peer_server.rs — bind the Rust iroh transport and serve /hello, so the INDEPENDENT JavaScript
// peer in demo/e2e/iroh-client.mjs can dial it. Two real iroh endpoints, two implementations.
//
//   ISA_IMMICH_API_KEY=test ISA_DATA_DIR=/tmp/isa-peer ISA_P2P_PORT=9711 \
//     cargo run --example peer_server
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::p2p::transport::{PeerAnswer, PeerHandler, Transport};
use immich_shared_albums::state;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let loaded = Config::from_env().expect("config");
    config::install(loaded);

    let booted = state::State::boot().expect("state boot");
    let identity = booted.keys().public.clone();
    state::install(booted);

    let handler: PeerHandler = Arc::new(move |caller: String, header, body| {
        Box::pin(async move {
            let (status, payload) = match header.path.as_str() {
                // The handshake the whole protocol hangs off: who we are, what we speak.
                "/hello" => (
                    200,
                    json!({
                        "protocol": 2,
                        "version": "1.1.1",
                        "features": ["sync-status"],
                        // Proves the caller identity came from the CONNECTION, not a header.
                        "you_are": caller,
                    }),
                ),
                // Echo the framing back, so the test can prove bytes survived both directions.
                "/echo" => (
                    200,
                    json!({
                        "path": header.path,
                        "range": header.range,
                        "mapping": header.mapping,
                        "body_len": body.len(),
                        "body": String::from_utf8_lossy(&body),
                    }),
                ),
                _ => (404, json!({ "error": "unknown route" })),
            };
            let mut headers = HashMap::new();
            headers.insert("content-type".to_string(), "application/json".to_string());
            PeerAnswer {
                status,
                headers: Some(headers),
                body: immich_shared_albums::p2p::transport::PeerBody::Bytes(
                    payload.to_string().into_bytes(),
                ),
            }
        })
    });

    let transport = Transport::start(handler).await.expect("transport start");

    // One line of JSON on stdout: what a peer needs to dial us.
    println!(
        "{}",
        json!({
            "pub": transport.public_key(),
            "identity": identity,
            "addrs": transport.direct_addresses(),
            "relay": transport.relay_url(),
        })
    );

    let _ = tokio::signal::ctrl_c().await;
}
