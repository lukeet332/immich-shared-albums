// materialise_probe.rs — drive the materialiser against a REAL Immich, so the upload, the
// attribution and the ledger are checked against the server rather than argued about.
//
//   ISA_IMMICH_API_KEY=<key> ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-mat \
//     cargo run --example materialise_probe -- <albumId>
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::client::Client;
use immich_shared_albums::immich::contributors::{ensure_utility_user, person_spec};
use immich_shared_albums::immich::materialise::materialise_ref;
use immich_shared_albums::immich::refs::{AssetRef, Contributor, RefExif};
use immich_shared_albums::state;
use immich_shared_albums::store::{Mapping, Peer, Role};
use serde_json::json;

#[tokio::main]
async fn main() {
    let album_id_arg = std::env::args().nth(1).unwrap_or_default();
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    let client = Client::new();

    // The ORIGIN's album is owned locally by a stand-in for its owner; that account holds the
    // mirror's assets and is what a human picks to share with.
    let host = ensure_utility_user(st, &client, &person_spec("Origin Owner", "origin-owner-id"))
        .await
        .expect("host stand-in");
    st.collections()
        .contributors
        .insert("host".to_string(), host.clone());

    // The MIRROR ALBUM is created by the host stand-in, not by the admin — that is what makes the
    // mirror owned by the right account, and it is what `mirror.ts` does. Creating it as the admin
    // instead leaves the stand-in unable to file anything into it (`no albumAsset.create access`),
    // which is exactly the failure this probe hit first.
    let album_id = if album_id_arg.is_empty() {
        let host_key = host.api_key.clone();
        assert!(!host_key.is_empty(), "host key");
        client
            .post(
                "/albums",
                &immich_shared_albums::immich::client::Auth::Key(&host_key),
                &json!({ "albumName": "Probe mirror" }),
            )
            .await
            .expect("create album")
            .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .expect("album id")
    } else {
        album_id_arg
    };

    // A MEMBER mapping: the local half is the peer's album, owned by that stand-in — which is why
    // `hostSlug` is what a read must use.
    st.collections().mappings.push(Mapping {
        id: "m-probe".into(),
        role: Role::Member,
        album_id: album_id.clone(),
        album_name: "Probe album".into(),
        peer: "peer-origin".into(),
        remote_album_id: None,
        remote_mapping_id: None,
        permissions: "contribute".into(),
        host_slug: Some("host".into()),
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
    let peer = Peer {
        pub_key: "peer-origin".into(),
        name: "Origin household".into(),
        version: Some("1.1.1".into()),
        protocol: Some(2),
        features: None,
        via: "link".into(),
        first_seen_at: config::iso_now(),
        relay_hint: None,
        last_addrs: None,
    };
    // The peer must be LINKED, or provisioning refuses: creating an account is a commitment on
    // behalf of a server, and finishing one for an unlinked server would leave an orphan bot with a
    // live key. This guard fired on the first run of this probe, which is why it is asserted here.
    st.collections().peers.push(peer.clone());
    st.save().expect("save state");

    // A photo ref WITH dimensions: the stub is sized to the origin's aspect ratio so Immich lays
    // the mirror out correctly.
    let reference = AssetRef {
        origin_asset: "origin-asset-probe".into(),
        checksum: format!("probe-checksum-{}", std::process::id()),
        checksum_alg: None,
        contributor: Contributor {
            display_name: "Remote Nan".into(),
            origin_user_id: Some("remote-person-id".into()),
        },
        kind: "image".into(),
        taken_at: Some("2026-01-02T03:04:05.000Z".into()),
        exif: Some(RefExif {
            latitude: Some(51.5),
            longitude: Some(-0.12),
            description: Some("A probe photo".into()),
            rating: Some(4),
            width: Some(4000),
            height: Some(3000),
        }),
    };

    let mapping = st
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == "m-probe")
        .cloned()
        .unwrap();
    match materialise_ref(st, &client, &mapping, &peer, &reference).await {
        Ok(true) => {
            let row = st.store.seen_for_mapping("m-probe").unwrap_or_default();
            let entry = row.first();
            println!(
                "{}",
                json!({
                    "ok": true,
                    "localAsset": entry.map(|e| e.local_asset.clone()),
                    "originAsset": entry.and_then(|e| e.origin_asset.clone()),
                    "storedFull": entry.map(|e| e.stored_full),
                })
            );
        }
        Ok(false) => println!("{}", json!({ "ok": false, "deferred": true })),
        Err(e) => println!("{}", json!({ "ok": false, "error": e })),
    }
}
