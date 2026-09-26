// reconcile_probe.rs — run the member's reconciler against a REAL origin, twice.
//
// The second run is the interesting one: an unchanged version must cost ONE row read at the origin
// and return before the manifest is pulled. That early return is what makes an idle album cheap.
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::client::Client;
use immich_shared_albums::p2p::transport::Transport;
use immich_shared_albums::state;
use immich_shared_albums::sync::engine::reconcile_once;
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

    let ledger = |st: &state::State| st.store.seen_for_mapping("m-seeded").map(|r| r.len()).unwrap_or(0);
    let cursor = |st: &state::State| {
        st.collections()
            .mappings
            .iter()
            .find(|m| m.id == "m-seeded")
            .and_then(|m| m.remote_version.clone())
    };

    println!("{}", json!({ "phase": "before", "ledger": ledger(st), "cursor": cursor(st) }));
    reconcile_once(st, &client).await;
    println!("{}", json!({ "phase": "after-first", "ledger": ledger(st), "cursor": cursor(st) }));
    reconcile_once(st, &client).await;
    println!("{}", json!({ "phase": "after-second", "ledger": ledger(st), "cursor": cursor(st) }));
}
