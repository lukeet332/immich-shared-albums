// provision_probe.rs — provision a real stand-in account against a real Immich, so the security
// properties can be asserted against the server rather than argued about.
//
//   ISA_IMMICH_API_KEY=<key> ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-prov \
//     cargo run --example provision_probe -- <origin-user-id> "<Display Name>"
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::client::Client;
use immich_shared_albums::immich::contributors::{ensure_utility_user, person_spec};
use immich_shared_albums::state;
use serde_json::json;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let origin_user_id = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "probe-person".into());
    let display_name = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "Probe Person".into());

    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);

    let client = Client::new();
    let spec = person_spec(&display_name, &origin_user_id);
    match ensure_utility_user(state::state(), &client, &spec).await {
        Ok(contributor) => {
            println!(
                "{}",
                json!({
                    "ok": true,
                    "stateKey": spec.state_key,
                    "email": spec.email,
                    "userId": contributor.user_id,
                    "hasApiKey": !contributor.api_key.is_empty(),
                    "retainedPassword": contributor.password.is_some(),
                })
            );
        }
        Err(e) => println!("{}", json!({ "ok": false, "error": e })),
    }
}
