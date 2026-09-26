// seed_proxy.rs — put a PROXY asset in a data dir: a stub owned by a stand-in, with the ledger row
// that says its true bytes live on a peer. Then the running sidecar's byte interceptor has something
// to intercept, which is the only way to exercise it without two live sidecars.
//
//   ISA_IMMICH_API_KEY=<key> ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-interceptor \
//     cargo run --example seed_proxy -- <originAssetId>
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::client::{add_to_album, stub_jpeg, upload_asset, Auth, Client};
use immich_shared_albums::immich::contributors::{ensure_utility_user, person_spec};
use immich_shared_albums::state;
use immich_shared_albums::store::{Identity, Mapping, Peer, Role};
use serde_json::json;

#[tokio::main]
async fn main() {
    let origin_asset = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "origin-asset-1".into());
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    let client = Client::new();

    // A REAL origin to face: its pub and address, and the identity this member proves itself with.
    // Set by the harness after the origin has accepted this member's join.
    let peer_pub = std::env::var("PEER_PUB").unwrap_or_else(|_| "peer-that-is-not-linked".into());
    let peer_addr = std::env::var("PEER_ADDR").ok();
    if let (Ok(pub_key), Ok(priv_key)) = (
        std::env::var("IDENTITY_PUB"),
        std::env::var("IDENTITY_PRIV"),
    ) {
        st.store.state.lock().unwrap().identity = Some(Identity {
            v: 1,
            alg: "ed25519".into(),
            public: pub_key,
            private: priv_key,
            created_at: config::iso_now(),
        });
    }

    // The stub is owned by a stand-in for the REMOTE person, which is who owns a mirrored photo.
    let person = person_spec("Remote Nan", "remote-nan-id");
    let stand_in = ensure_utility_user(st, &client, &person)
        .await
        .expect("stand-in");
    let key = stand_in.api_key.clone();
    assert!(!key.is_empty(), "stand-in key");

    let album_id = client
        .post(
            "/albums",
            &Auth::Key(&key),
            &json!({ "albumName": "Intercepted mirror" }),
        )
        .await
        .expect("create album")
        .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .expect("album id");

    let asset = upload_asset(&client, &stub_jpeg(), "proxy-stub.jpg", &key, None)
        .await
        .expect("upload stub");
    let asset_id = asset
        .get("id")
        .and_then(|v| v.as_str())
        .expect("asset id")
        .to_string();
    add_to_album(&client, &album_id, std::slice::from_ref(&asset_id), &key)
        .await
        .expect("file the stub into the mirror");

    // A real viewer is a MEMBER of the mirror album, and that membership is what grants
    // `asset.read` on a stub owned by a stand-in. Without it the interceptor's probe correctly
    // answers 400 and the photo is not served — which is why this is part of the fixture.
    let me = client
        .get("/users/me", &Auth::Admin)
        .await
        .expect("whoami")
        .and_then(|u| u.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .expect("admin user id");
    client
        .json(
            reqwest::Method::PUT,
            &format!("/albums/{album_id}/users"),
            &Auth::Key(&key),
            Some(&json!({ "albumUsers": [{ "userId": me, "role": "viewer" }] })),
        )
        .await
        .expect("share the mirror with the local viewer");

    st.collections().mappings.push(Mapping {
        id: "m-intercept".into(),
        role: Role::Member,
        album_id: album_id.clone(),
        album_name: "Intercepted mirror".into(),
        peer: peer_pub.clone(),
        remote_album_id: Some(
            std::env::var("REMOTE_ALBUM_ID").unwrap_or_else(|_| "remote-album-1".into()),
        ),
        remote_mapping_id: None,
        permissions: "view".into(),
        host_slug: Some(person.state_key.clone()),
        via: "link".into(),
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
    st.collections().peers.push(Peer {
        pub_key: peer_pub.clone(),
        name: "Origin".into(),
        version: Some("1.1.1".into()),
        protocol: Some(2),
        features: None,
        via: "link".into(),
        first_seen_at: config::iso_now(),
        relay_hint: None,
        last_addrs: peer_addr.map(|a| vec![a]),
    });
    // `storedFull: false` is what makes this a PROXY row: the local asset is a stub, so the
    // interceptor is the only thing that can serve its true pixels.
    st.store
        .seen_add(
            "m-intercept",
            "checksum-1",
            &asset_id,
            Some(&origin_asset),
            false,
        )
        .expect("record the ledger row");
    st.save().expect("save");

    println!(
        "{}",
        json!({ "assetId": asset_id, "albumId": album_id, "originAsset": origin_asset })
    );
}
