// leave_probe.rs — leave a mirror against a REAL Immich, and prove the space came back.
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::client::{Auth, Client};
use immich_shared_albums::p2p::transport::Transport;
use immich_shared_albums::state;
use immich_shared_albums::sync::leave::leave_album;
use serde_json::json;

#[tokio::main]
async fn main() {
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    let client = Client::new();
    immich_shared_albums::p2p::transport::install(
        Transport::start(immich_shared_albums::p2p::routes::handler())
            .await
            .expect("transport"),
    );

    let before = st
        .store
        .seen_for_mapping("m-seeded")
        .map(|r| r.len())
        .unwrap_or(0);
    let stub = st
        .store
        .seen_for_mapping("m-seeded")
        .unwrap_or_default()
        .first()
        .map(|r| r.local_asset.clone());
    let album_id = st
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == "m-seeded")
        .map(|m| m.album_id.clone());
    // The stub is owned by the CONTRIBUTOR stand-in, so that key is the one that can see it.
    let slug = st
        .collections()
        .mappings
        .iter()
        .find(|m| m.id == "m-seeded")
        .and_then(|m| m.host_slug.clone());
    let host_key = slug
        .as_ref()
        .and_then(|s| st.collections().contributors.get(s).cloned())
        .map(|c| c.api_key.clone())
        // Empty = not provisioned; the probe asked for a provisioned stand-in.
        .filter(|key| !key.is_empty())
        .expect("the mapping names a host stand-in, and we hold its key");

    // Self-contained: leave is only meaningful over a stub we actually created, so make one when
    // the ledger is empty. The stub is owned by the HOST STAND-IN — the account that owns the
    // mirror — which is exactly the ownership the purge has to resolve without the admin key.
    if before == 0 {
        let bytes = immich_shared_albums::immich::client::stub_jpeg();
        let asset = immich_shared_albums::immich::client::upload_asset(
            &client,
            &bytes,
            "leave-probe.jpg",
            &host_key,
            None,
        )
        .await
        .expect("upload stub as the stand-in");
        let asset_id = asset
            .get("id")
            .and_then(|v| v.as_str())
            .expect("asset id")
            .to_string();
        if let Some(album) = &album_id {
            immich_shared_albums::immich::client::add_to_album(
                &client,
                album,
                std::slice::from_ref(&asset_id),
                &host_key,
            )
            .await
            .expect("file the stub into the mirror");
        }
        st.store
            .seen_add(
                "m-seeded",
                "seeded-checksum",
                &asset_id,
                Some("origin-asset"),
                false,
            )
            .expect("record the ledger row");
        println!("(seeded a stub owned by the host stand-in: {asset_id})");
    }

    let before = st
        .store
        .seen_for_mapping("m-seeded")
        .map(|r| r.len())
        .unwrap_or(0);

    let outcome = leave_album(st, &client, "m-seeded", true).await;
    let after_ledger = st
        .store
        .seen_for_mapping("m-seeded")
        .map(|r| r.len())
        .unwrap_or(0);

    // Can the stub still be read? The admin key proves nothing on its own — Immich scopes reads per
    // credential, so an asset owned by a stand-in 404s to the admin whether or not it exists. Ask
    // EVERY credential we hold and report which ones see it.
    let mut readable_by: Vec<String> = Vec::new();
    if let Some(id) = &stub {
        if client
            .get(&format!("/assets/{id}"), &Auth::Admin)
            .await
            .map(|v| v.is_some())
            .unwrap_or(false)
        {
            readable_by.push("admin".to_string());
        }
        // COLLECTED FIRST: the `collections()` guard must not be held across the reads below, which
        // await. Holding it is how this port deadlocks, and clippy refuses it for the same reason.
        let keys: Vec<(String, String)> = st
            .collections()
            .contributors
            .iter()
            .filter(|(_, c)| !c.api_key.is_empty())
            .map(|(slug, c)| (slug.clone(), c.api_key.clone()))
            .collect();
        for (slug, key) in keys {
            if client
                .get(&format!("/assets/{id}"), &Auth::Key(&key))
                .await
                .map(|v| v.is_some())
                .unwrap_or(false)
            {
                readable_by.push(slug);
            }
        }
    }
    let album_still_there = match &album_id {
        Some(id) => client
            .get(&format!("/albums/{id}?withoutAssets=true"), &Auth::Admin)
            .await
            .map(|v| v.is_some())
            .unwrap_or(false),
        None => false,
    };

    println!(
        "{}",
        json!({
            "beforeLedger": before,
            "afterLedger": after_ledger,
            "purged": outcome.as_ref().map(|o| o.purged).unwrap_or(0),
            "left": outcome.as_ref().map(|o| o.left.clone()).unwrap_or_default(),
            "error": outcome.as_ref().err().cloned(),
            "stubReadableBy": readable_by,
            "refused": outcome.as_ref().map(|o| o.refused).unwrap_or(0),
            "failed": outcome.as_ref().map(|o| o.failed).unwrap_or(0),
            "albumStillReadable": album_still_there,
            "mappingGone": st.collections().mappings.iter().all(|m| m.id != "m-seeded"),
        })
    );
}
