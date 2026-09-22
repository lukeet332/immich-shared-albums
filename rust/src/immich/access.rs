/** immich/access.rs — whose Immich credential reads a local album. See PORT.md. */
use axum::http::HeaderMap;
use std::collections::HashMap;

/// Credentials forwarded on behalf of a signed-in caller, exactly as Immich receives them.
#[derive(Clone, Debug, PartialEq)]
pub struct Creds {
    pub headers: HashMap<String, String>,
}

/// Headers that carry a caller's identity. ONE list, because a second copy drifts.
pub const CRED_HEADER_NAMES: [&str; 3] = ["cookie", "x-api-key", "authorization"];

/// A caller's Immich credential as forwarded headers, or `None` when they sent none.
pub fn creds_from_headers(headers: &HeaderMap) -> Option<Creds> {
    let mut out = HashMap::new();
    for name in CRED_HEADER_NAMES {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            if !value.is_empty() {
                out.insert(name.to_string(), value.to_string());
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Creds { headers: out })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn forwards_only_the_three_identity_headers() {
        let h = headers(&[
            ("cookie", "immich_access_token=abc"),
            ("x-api-key", "key-1"),
            ("authorization", "Bearer t"),
            // Anything else is not an identity and must not be forwarded as one.
            ("user-agent", "Mozilla/5.0"),
            ("x-forwarded-for", "10.0.0.1"),
        ]);
        let creds = creds_from_headers(&h).unwrap();
        assert_eq!(creds.headers.len(), 3);
        assert_eq!(creds.headers.get("cookie").unwrap(), "immich_access_token=abc");
        assert_eq!(creds.headers.get("x-api-key").unwrap(), "key-1");
        assert_eq!(creds.headers.get("authorization").unwrap(), "Bearer t");
        assert!(!creds.headers.contains_key("user-agent"));
    }

    #[test]
    fn no_credential_header_means_not_signed_in_rather_than_an_empty_credential() {
        assert!(creds_from_headers(&headers(&[("user-agent", "x")])).is_none());
        assert!(creds_from_headers(&HeaderMap::new()).is_none());
        // An empty value is not a credential either.
        assert!(creds_from_headers(&headers(&[("x-api-key", "")])).is_none());
    }

    #[test]
    fn header_lookup_is_case_insensitive_as_http_requires() {
        let creds = creds_from_headers(&headers(&[("X-Api-Key", "key-1")])).unwrap();
        assert_eq!(creds.headers.get("x-api-key").unwrap(), "key-1");
    }
}

/// The albums this caller can see, as IMMICH answers for their own credential.
///
/// Failure and emptiness are DIFFERENT answers and must not share one value: `None` means the read
/// was refused (the credential is not valid), `Some(vec![])` means the caller genuinely has no
/// albums. Collapsing them is how a panel ends up telling someone they own nothing when in fact the
/// sidecar could not ask.
pub async fn read_caller_albums(
    client: &crate::immich::client::Client,
    creds: &Creds,
) -> Option<Vec<serde_json::Value>> {
    match client.get("/albums", &crate::immich::client::Auth::Creds(creds)).await {
        Ok(Some(serde_json::Value::Array(albums))) => Some(albums),
        Ok(Some(_)) => Some(Vec::new()),
        Ok(None) => Some(Vec::new()),
        Err(_) => None,
    }
}

/// The ids of the albums a caller may see.
///
/// Immich scopes `GET /albums` to the credential, so this IS the caller's own membership — never a
/// list to filter for them. A mapping whose album is absent from it is not leaked, because the
/// question is never asked of a list the caller cannot have.
pub async fn visible_album_ids(
    client: &crate::immich::client::Client,
    creds: &Creds,
) -> Option<std::collections::HashSet<String>> {
    let albums = read_caller_albums(client, creds).await?;
    Some(
        albums
            .iter()
            .filter_map(|a| a.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect(),
    )
}

/// The local album as the given credential can see it, or `None` when it cannot.
///
/// `None` is the point: a caller cannot go on to read `albumUsers` off a refusal, which is how a
/// panel ends up filtering a plan it never had.
pub async fn read_album_as(
    client: &crate::immich::client::Client,
    album_id: &str,
    auth: &crate::immich::client::Auth<'_>,
) -> Option<serde_json::Value> {
    client.get_album(album_id, auth).await.ok().flatten()
}

/// Every asset the credential can see in the album, or `None` when it cannot see the album at all.
///
/// An EMPTY album and a REFUSED read are different answers and must not share one value: collapsing
/// them is the silent failure this module exists to remove.
pub async fn read_album_assets_as(
    client: &crate::immich::client::Client,
    album_id: &str,
    auth: &crate::immich::client::Auth<'_>,
) -> Option<Vec<serde_json::Value>> {
    let mut out = Vec::new();
    let mut page = 1i64;
    while page > 0 {
        let body = serde_json::json!({
            "albumIds": [album_id],
            "page": page,
            "size": 500,
            "withExif": true,
        });
        let response = match client.post("/search/metadata", auth, &body).await {
            Ok(Some(value)) => value,
            _ => return None,
        };
        if let Some(items) = response.pointer("/assets/items").and_then(|v| v.as_array()) {
            out.extend(items.iter().cloned());
        }
        page = response
            .pointer("/assets/nextPage")
            .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_i64()))
            .unwrap_or(0);
    }
    Some(out)
}
