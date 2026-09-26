// origin_push.rs — drive pushAlbumRefs against a REAL member sidecar: read this household's own
// album, compute what is new, and push it over iroh.
//
//   ISA_IMMICH_API_KEY=<key> ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-origin \
//     PEER_PUB=<member pub> PEER_ADDR=127.0.0.1:9431 IDENTITY_PRIV=<b64url> IDENTITY_PUB=<b64url> \
//     cargo run --example origin_push
use immich_shared_albums::config::{self, iso_now, Config};
use immich_shared_albums::immich::client::{Auth, Client};
use immich_shared_albums::p2p::transport::Transport;
use immich_shared_albums::state;
use immich_shared_albums::store::{Identity, Mapping, Peer, Role};
use immich_shared_albums::sync::engine::push_album_refs;
use serde_json::json;

#[tokio::main]
async fn main() {
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    let client = Client::new();

    // Adopt the identity the member was seeded with, so the connection proves the key it knows.
    if let (Ok(pub_key), Ok(priv_key)) = (
        std::env::var("IDENTITY_PUB"),
        std::env::var("IDENTITY_PRIV"),
    ) {
        st.store.state.lock().unwrap().identity = Some(Identity {
            v: 1,
            alg: "ed25519".into(),
            public: pub_key,
            private: priv_key,
            created_at: iso_now(),
        });
        st.save().expect("save identity");
    }

    // This household's OWN album, with a photo in it.
    let admin = Auth::Admin;
    let existing = std::env::var("ALBUM_ID").ok().filter(|v| !v.is_empty());
    let album = match existing {
        Some(id) => id,
        None => client
            .post("/albums", &admin, &json!({ "albumName": "Origin album" }))
            .await
            .expect("create album")
            .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .expect("album id"),
    };
    // A REAL jpeg: Immich measures dimensions asynchronously, and an unmeasured photo is held back
    // from every push by design — so a fake byte string would test the hold-back, not the push.
    let fixture =
        std::env::var("FIXTURE").unwrap_or_else(|_| "../demo/e2e/fixtures/fx0.jpg".to_string());
    let bytes = std::fs::read(&fixture).expect("fixture photo");
    let form = reqwest::multipart::Form::new()
        .text(
            "deviceAssetId",
            format!("origin-push-{}", std::process::id()),
        )
        .text("deviceId", "origin-push")
        .text("fileCreatedAt", iso_now())
        .text("fileModifiedAt", iso_now())
        .part(
            "assetData",
            reqwest::multipart::Part::bytes(bytes).file_name("origin.jpg"),
        );
    // Phase 1 creates the album and stops, so the member can be seeded with its id.
    if std::env::var("PHASE").as_deref() == Ok("create") {
        println!("{}", json!({ "albumId": album }));
        return;
    }
    let uploaded = client
        .upload("/assets", &config::cfg().api_key, form)
        .await
        .expect("upload");
    let asset_id = uploaded
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let _ = client
        .json(
            reqwest::Method::PUT,
            &format!("/albums/{album}/assets"),
            &admin,
            Some(&json!({ "ids": [asset_id] })),
        )
        .await;

    // Wait for Immich's metadata job, or the ref is legitimately held back for having no shape.
    for _ in 0..40 {
        let measured = client
            .get(&format!("/assets/{asset_id}"), &admin)
            .await
            .ok()
            .flatten()
            .and_then(|a| {
                a.pointer("/exifInfo/exifImageWidth")
                    .and_then(|v| v.as_i64())
            })
            .is_some();
        if measured {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let peer_pub = std::env::var("PEER_PUB").expect("PEER_PUB");
    let peer_addr = std::env::var("PEER_ADDR").expect("PEER_ADDR");
    st.collections().mappings.push(Mapping {
        id: "m-origin".into(),
        role: Role::Owner,
        album_id: album.clone(),
        album_name: "Origin album".into(),
        peer: peer_pub.clone(),
        remote_album_id: None,
        remote_mapping_id: None,
        permissions: "contribute".into(),
        host_slug: None,
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
        pub_key: peer_pub,
        name: "Member household".into(),
        version: Some("1.1.1".into()),
        protocol: Some(2),
        features: None,
        via: "link".into(),
        first_seen_at: iso_now(),
        relay_hint: None,
        last_addrs: Some(vec![peer_addr]),
    });
    st.save().expect("save state");

    // The REAL peer routes. A stub handler that 404s everything makes the server look alive while
    // answering nothing, which is exactly how this ran for a whole round without a result.
    let transport = Transport::start(immich_shared_albums::p2p::routes::handler())
        .await
        .expect("transport");
    immich_shared_albums::p2p::transport::install(transport);

    if std::env::var("PHASE").as_deref() == Ok("seed") {
        // Settle the album so its version is stable before the member reads it.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        println!("{}", json!({ "albumId": album, "assetId": asset_id }));
        tokio::signal::ctrl_c().await.ok();
        return;
    }
    let mapping = st
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == "m-origin")
        .cloned()
        .unwrap();
    let peer = st
        .collections()
        .peers
        .iter()
        .find(|p| p.name == "Member household")
        .cloned()
        .unwrap();
    match push_album_refs(st, &client, &mapping, &peer).await {
        Ok(outcome) => println!(
            "{}",
            json!({ "ok": true, "inSync": outcome.in_sync, "albumId": album, "assetId": asset_id })
        ),
        Err(e) => println!("{}", json!({ "ok": false, "error": e })),
    }
}
