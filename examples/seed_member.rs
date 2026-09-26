// seed_member.rs — prepare a data dir as a MEMBER sidecar: a host stand-in, a mirror album it owns,
// and a member mapping facing a linked peer. Then the real `isa` binary runs against the same dir,
// so the /refs route can be driven over iroh exactly as an origin would drive it.
use immich_shared_albums::config::{self, iso_now, Config};
use immich_shared_albums::immich::client::{Auth, Client};
use immich_shared_albums::immich::contributors::{ensure_utility_user, person_spec};
use immich_shared_albums::state;
use immich_shared_albums::store::{Mapping, Peer, Role};
use serde_json::json;

#[tokio::main]
async fn main() {
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    let client = Client::new();

    let host = ensure_utility_user(st, &client, &person_spec("Origin Owner", "origin-owner-id"))
        .await
        .expect("host stand-in");
    let host_key = host.api_key.clone().expect("host key");
    // The mirror is created BY the stand-in, so it owns what is filed into it.
    let album_id = client
        .post(
            "/albums",
            &Auth::Key(&host_key),
            &json!({ "albumName": "Seeded mirror" }),
        )
        .await
        .expect("create album")
        .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .expect("album id");
    // The contributor table has `userId UNIQUE`, so an account is referenced by its OWN slug —
    // aliasing the same person under a second slug violates the schema. The mapping's `hostSlug`
    // IS the stand-in's state key.
    let host_slug = person_spec("Origin Owner", "origin-owner-id").state_key;
    assert_eq!(
        st.collections()
            .contributors
            .get(&host_slug)
            .map(|c| c.user_id.clone()),
        Some(host.user_id.clone())
    );

    // The mapping and the peer must name the SAME key: a mapping whose `peer` does not match the
    // connection's caller is invisible to every route that resolves it.
    let peer_pub = std::env::var("PEER_PUB").unwrap_or_else(|_| "peer-origin".into());
    st.collections().mappings.push(Mapping {
        id: "m-seeded".into(),
        role: Role::Member,
        album_id: album_id.clone(),
        album_name: "Seeded mirror".into(),
        peer: peer_pub.clone(),
        // The id the ORIGIN's routes address this album by. A real join gets it from the redeem
        // response; without it the member cannot resolve anything the origin pushes.
        remote_album_id: std::env::var("REMOTE_ALBUM_ID").ok(),
        remote_mapping_id: None,
        permissions: "contribute".into(),
        host_slug: Some(host_slug),
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
        name: "Origin household".into(),
        version: Some("1.1.1".into()),
        protocol: Some(2),
        features: None,
        via: "link".into(),
        first_seen_at: iso_now(),
        relay_hint: None,
        // Where to dial the origin. A real join records this from the share page's endpoint token;
        // without it the member has a mapping but no way to reach the server behind it.
        last_addrs: std::env::var("PEER_ADDR").ok().map(|a| vec![a]),
    });
    st.save().expect("save state");
    let peer_pub = st
        .collections()
        .peers
        .last()
        .map(|p| p.pub_key.clone())
        .unwrap_or_default();
    println!(
        "{}",
        json!({ "albumId": album_id, "mappingId": "m-seeded", "peerPub": peer_pub })
    );
}
