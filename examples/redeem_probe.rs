// redeem_probe.rs — redeem a share invite from the MEMBER side, against a real origin over iroh.
//
//   ISA_IMMICH_API_KEY=k ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-redeem-probe \
//   ISA_PORT=9450 ISA_P2P_PORT=9451 ISA_RELAY=off \
//     cargo run --example redeem_probe -- <endpointToken> <shareKey> [password]
//
// Prints one JSON line. Nothing is mirrored here: this exercises the HANDSHAKE, so what it proves is
// that the origin enrolled us, offered the album, and answered with an identity matching the invite.
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::p2p::join::{redeem_invite, Invite};
use immich_shared_albums::p2p::transport::Transport;
use immich_shared_albums::state;
use base64::Engine as _;
use serde_json::json;

#[tokio::main]
async fn main() {
    let token = std::env::args().nth(1).unwrap_or_default();
    let key = std::env::args().nth(2).unwrap_or_default();
    let password = std::env::args().nth(3);

    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    immich_shared_albums::p2p::transport::install(
        Transport::start(immich_shared_albums::p2p::routes::handler())
            .await
            .expect("transport"),
    );

    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .expect("endpoint token is base64url");
    let endpoint: serde_json::Value = serde_json::from_slice(&decoded).expect("endpoint token is json");

    let invite = Invite {
        endpoint_pub: endpoint.get("pub").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        endpoint_relay: endpoint.get("relay").and_then(|v| v.as_str()).map(str::to_string),
        endpoint_addrs: endpoint.get("addrs").and_then(|v| v.as_array()).map(|a| {
            a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
        }),
        key,
    };

    match redeem_invite(st, &invite, password.as_deref()).await {
        Ok(redeemed) => println!(
            "{}",
            json!({
                "ok": true,
                "household": redeemed.household_name,
                "publicKey": redeemed.household_public_key,
                "album": redeemed.album_name,
                "albumId": redeemed.album_id,
                "permissions": redeemed.permissions,
                "remoteMappingId": redeemed.remote_mapping_id,
                "ownerName": redeemed.owner_display_name,
                "ownerUserId": redeemed.owner_user_id,
                "reunified": redeemed.reunified,
                "manifest": redeemed.manifest_len,
                // What the MEMBER recorded. A redeem that answered correctly but pinned nothing
                // would leave the two servers unable to speak again.
                "pinnedPeers": st.collections().peers.len(),
            })
        ),
        Err(refused) => println!(
            "{}",
            json!({
                "ok": false,
                "message": refused.message,
                "passwordRequired": refused.password_required,
                "pinnedPeers": st.collections().peers.len(),
            })
        ),
    }
}
