// caller_albums_probe.rs — prove IMMICH scopes GET /albums, against a real server.
//
//   ISA_IMMICH_API_KEY=<key> ISA_IMMICH_URL=http://localhost:2384 ISA_DATA_DIR=/tmp/isa-caller-albums \
//     cargo run --example caller_albums_probe
//
// The whole per-user panel rests on this: the sidecar holds no credential for a human, so a caller's
// albums are whatever Immich answers for THEIR credential. If that list were the admin's, every
// panel would show the wrong person's albums and a mapping the caller cannot see would leak.
use axum::http::HeaderMap;
use immich_shared_albums::config::{self, Config};
use immich_shared_albums::immich::access::{
    creds_from_headers, read_caller_albums, visible_album_ids,
};
use immich_shared_albums::immich::client::{Auth, Client};
use immich_shared_albums::state;
use serde_json::json;

/// A caller's credential, forwarded exactly as the HTTP layer forwards one.
fn creds_with(name: &str, value: &str) -> immich_shared_albums::immich::access::Creds {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
        value.parse().expect("header value"),
    );
    creds_from_headers(&headers).expect("creds")
}

#[tokio::main]
async fn main() {
    config::install(Config::from_env().expect("config"));
    let booted = state::State::boot().expect("state");
    state::install(booted);
    let client = Client::new();
    let img = config::cfg().immich_url.clone();

    // A second human with an album of their own. Signed in for a TOKEN rather than an API key: the
    // point is to read as a different person, and a bearer token is exactly what their browser sends.
    let email = format!("caller-albums-{}@e2e.local", std::process::id());
    client
        .post(
            "/admin/users",
            &Auth::Admin,
            &json!({ "email": email, "password": "caller-albums-pass-1", "name": "Other Person" }),
        )
        .await
        .ok();

    let http = reqwest::Client::new();
    let login: serde_json::Value = http
        .post(format!("{img}/api/auth/login"))
        .json(&json!({ "email": email, "password": "caller-albums-pass-1" }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    let token = login
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let other_id = login
        .get("userId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // The admin's album, and one belonging to the other person. The second is created with THAT
    // person's own token, because only they can own an album.
    let admin_album = client
        .post(
            "/albums",
            &Auth::Admin,
            &json!({ "albumName": "Admin only" }),
        )
        .await
        .expect("create the admin's album")
        .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .expect("album id");
    let other_creds = creds_with("authorization", &format!("Bearer {token}"));
    let other_album = client
        .post(
            "/albums",
            &Auth::Creds(&other_creds),
            &json!({ "albumName": "Other person only" }),
        )
        .await
        .expect("create the other person's album")
        .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .expect("album id");

    let admin_creds = creds_with("x-api-key", &config::cfg().api_key);
    let ids = |list: &Option<Vec<serde_json::Value>>| -> Vec<String> {
        list.clone()
            .unwrap_or_default()
            .iter()
            .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect()
    };
    let admin_ids = ids(&read_caller_albums(&client, &admin_creds).await);
    let other_ids = ids(&read_caller_albums(&client, &other_creds).await);

    // An invalid credential is a REFUSED read, not an empty one. The panel depends on telling
    // "this person owns nothing" from "we could not ask".
    let refused = read_caller_albums(&client, &creds_with("x-api-key", "not-a-real-key")).await;
    let visible = visible_album_ids(&client, &admin_creds)
        .await
        .unwrap_or_default();

    println!(
        "{}",
        json!({
            "adminSeesTheirOwnAlbum": admin_ids.contains(&admin_album),
            "adminDoesNotSeeTheOtherPersonsAlbum": !admin_ids.contains(&other_album),
            "otherSeesTheirOwnAlbum": other_ids.contains(&other_album),
            "otherDoesNotSeeTheAdminsAlbum": !other_ids.contains(&admin_album),
            "theTwoListsDiffer": admin_ids != other_ids,
            "anInvalidCredentialIsREFUSEDnotEmpty": refused.is_none(),
            "theOtherPersonIsReal": !other_id.is_empty(),
            "visibleIdsMatchTheListLength": visible.len() == admin_ids.len(),
        })
    );
}
