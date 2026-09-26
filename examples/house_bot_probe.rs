// house_bot_probe.rs — provision the house bot against a REAL Immich and prove what it is.
//
//   ISA_IMMICH_API_KEY=<key> ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-house-bot \
//     cargo run --example house_bot_probe
//
// Prints one JSON line. The account's NAME and its PERMISSIONS are the contract: a suffix on the
// name would claim it stands in for a person, and a write scope would let it change a library it is
// only ever supposed to read.
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::access::Creds;
use immich_shared_albums::immich::client::{Auth, Client};
use immich_shared_albums::state;
use immich_shared_albums::sync::house_bot::{
    add_house_bot_to_album, ensure_house_bot, HOUSE_BOT_DISPLAY_NAME, HOUSE_BOT_PERMISSIONS,
};
use serde_json::json;
use std::collections::HashMap;

#[tokio::main]
async fn main() {
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let st = state::state();
    let client = Client::new();

    let first = ensure_house_bot(st, &client)
        .await
        .expect("provision the house bot");
    // Provisioned twice on purpose: it is created lazily, so every caller may ask, and a second
    // call must return the SAME account rather than making another one.
    let second = ensure_house_bot(st, &client)
        .await
        .expect("provision again");
    let bot_id = first.user_id.clone().expect("bot user id");

    // The name as IMMICH holds it, not as we asked for it — a rename elsewhere would be invisible
    // to a check that only read our own record.
    let live = client
        .get(&format!("/admin/users/{bot_id}"), &Auth::Admin)
        .await
        .ok()
        .flatten();
    let live_name = live
        .as_ref()
        .and_then(|u| u.get("name").and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();

    // An album owned by the ADMIN, so the bot joining it is a real membership on someone else's
    // album — the case `addHouseBotToAlbum` exists for.
    let album = client
        .post(
            "/albums",
            &Auth::Admin,
            &json!({ "albumName": "House bot probe" }),
        )
        .await
        .expect("create album")
        .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .expect("album id");

    // The OWNER's credentials: a caller's own forwarded key. The probe holds the household key, so
    // that is what it forwards — the point is that the credential is the owner's, not the bot's.
    let mut headers = HashMap::new();
    headers.insert("x-api-key".to_string(), config::cfg().api_key.clone());
    let owner_creds = Creds { headers };

    add_house_bot_to_album(st, &client, &album, &owner_creds)
        .await
        .expect("first add");
    add_house_bot_to_album(st, &client, &album, &owner_creds)
        .await
        .expect("second add");

    let after = client
        .get_album(&album, &Auth::Creds(&owner_creds))
        .await
        .ok()
        .flatten();
    let members: Vec<String> = after
        .as_ref()
        .and_then(|a| a.get("albumUsers"))
        .and_then(|u| u.as_array())
        .map(|users| {
            users
                .iter()
                .filter(|au| {
                    au.pointer("/user/id").and_then(|v| v.as_str()) == Some(bot_id.as_str())
                })
                .map(|au| {
                    au.get("role")
                        .and_then(|r| r.as_str())
                        .unwrap_or("?")
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default();

    // The bot reads the album with ITS OWN key — the whole reason it was added.
    let readable = client
        .get_album(
            &album,
            &Auth::Key(first.api_key.as_deref().unwrap_or_default()),
        )
        .await
        .ok()
        .flatten()
        .is_some();

    // The bot must NOT be able to enumerate its own keys: `apiKey.read` is deliberately absent, and
    // a scope list you can read back is one you could also widen. This is the strongest statement
    // available from outside — Immich has no endpoint that shows one account another's key scopes.
    let bot_key = first.api_key.as_deref().unwrap_or_default();
    let can_list_own_keys = client
        .get("/api-keys", &Auth::Key(bot_key))
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_array().map(|a| !a.is_empty()))
        .unwrap_or(false);

    // And it cannot do the one thing a widened key would allow: mint another key.
    let can_mint_keys = client
        .post(
            "/api-keys",
            &Auth::Key(bot_key),
            &json!({ "name": "widened", "permissions": ["all"] }),
        )
        .await
        .is_ok();

    println!(
        "{}",
        json!({
            "nameAsImmichHoldsIt": live_name,
            "nameIsVerbatim": live_name == HOUSE_BOT_DISPLAY_NAME,
            "sameAccountOnSecondCall": first.user_id == second.user_id,
            "oneRecordInState": st.collections().contributors.len(),
            "membershipsForTheBot": members,
            "botCanReadTheAlbum": readable,
            "permissionCount": HOUSE_BOT_PERMISSIONS.len(),
            "canListItsOwnKeys": can_list_own_keys,
            "canMintAnotherKey": can_mint_keys,
        })
    );
}
