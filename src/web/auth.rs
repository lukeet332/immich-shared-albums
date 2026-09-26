/** web/auth.rs — who is calling a human-facing sidecar route. See ARCHITECTURE.md. */
use crate::config::cfg;
use crate::immich::access::{creds_from_headers, Creds};
use axum::http::HeaderMap;

/// How long Immich may take to answer "who is this". Shorter than a data call: a person is waiting.
const WHOAMI_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq)]
pub struct Caller {
    pub id: String,
    pub name: String,
    pub is_admin: bool,
}

/// A signed-in caller and the credential that proved it. Per-user surfaces must read Immich AS this
/// caller — filtering someone else's read for them is how a panel ends up empty.
#[derive(Clone, Debug)]
pub struct SignedIn {
    pub caller: Caller,
    pub creds: Creds,
}

/// The caller's forwarded credential, or `None` when they sent none.
pub fn caller_creds(headers: &HeaderMap) -> Option<Creds> {
    creds_from_headers(headers)
}

/// One pool for every "who is this" call, for the same reason `passthrough::upstream` exists: a
/// `reqwest::Client` owns a connection pool, so building one per call opens a fresh TCP connection
/// to Immich for every authenticated page and panel request. The deadline stays short — a person is
/// waiting on this one.
static WHOAMI: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn whoami_client() -> Option<&'static reqwest::Client> {
    if let Some(client) = WHOAMI.get() {
        return Some(client);
    }
    let built = reqwest::Client::builder()
        .timeout(WHOAMI_DEADLINE)
        .build()
        .ok()?;
    Some(WHOAMI.get_or_init(|| built))
}

/// Resolve the caller against Immich, or `None` if they are not signed in.
///
/// The sidecar has no accounts of its own and must never invent any: the only identity that means
/// anything here is an Immich one, so we forward whatever the caller already has and let Immich
/// answer. Being able to reach a route is never permission to use it.
pub async fn caller_signed_in(headers: &HeaderMap) -> Option<SignedIn> {
    let creds = caller_creds(headers)?;
    let http = whoami_client()?;
    let mut req = http
        .get(format!(
            "{}/api/users/me",
            cfg().immich_url.trim_end_matches('/')
        ))
        .header("Accept", "application/json");
    for (name, value) in &creds.headers {
        req = req.header(name, value);
    }
    let response = req.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let user: serde_json::Value = response.json().await.ok()?;
    let id = user.get("id")?.as_str()?.to_string();
    Some(SignedIn {
        caller: Caller {
            id,
            name: user
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string(),
            is_admin: user
                .get("isAdmin")
                .and_then(|a| a.as_bool())
                .unwrap_or(false),
        },
        creds,
    })
}

/// Who is calling, when the credential itself is not needed.
pub async fn caller_identity(headers: &HeaderMap) -> Option<Caller> {
    caller_signed_in(headers).await.map(|s| s.caller)
}

/// The 401 body that tells a browser where to go to fix it.
pub fn sign_in_required(what: &str) -> serde_json::Value {
    serde_json::json!({
        "error": format!("sign in to {} to {}", cfg().name, what),
        "signInUrl": "/auth/login",
        "needsAuth": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_config() {
        crate::config::install_test_config();
    }

    #[tokio::test]
    async fn no_credential_is_not_signed_in_and_never_calls_immich() {
        install_config();
        // Unreachable Immich: if this made a call it would take the deadline to answer.
        assert!(caller_signed_in(&HeaderMap::new()).await.is_none());
    }

    #[tokio::test]
    async fn an_unreachable_immich_reads_as_signed_out_rather_than_an_error() {
        install_config();
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", "anything".parse().unwrap());
        // FAIL CLOSED: a route that cannot verify the caller must not serve them.
        assert!(caller_signed_in(&headers).await.is_none());
    }

    #[test]
    fn the_sign_in_body_names_the_household_and_where_to_go() {
        install_config();
        let body = sign_in_required("join a shared album");
        assert_eq!(body["needsAuth"], true);
        assert_eq!(body["signInUrl"], "/auth/login");
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("join a shared album"));
        assert!(body["error"].as_str().unwrap().contains("Test household"));
    }
}
