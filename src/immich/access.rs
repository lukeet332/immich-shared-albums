/** immich/access.rs — whose Immich credential reads a local album. See ARCHITECTURE.md. */
use axum::http::HeaderMap;
use std::collections::HashMap;

use crate::immich::client::Auth;
use crate::state::State;
use crate::store::{Mapping, Role};

/// Credentials forwarded on behalf of a signed-in caller, exactly as Immich receives them.
#[derive(Clone, Debug, PartialEq)]
pub struct Creds {
    pub headers: HashMap<String, String>,
}

/// The credential that can read a mapping's album, OWNED.
///
/// `Auth::Key` borrows, so a helper that built it from a freshly cloned key had to `Box::leak` it —
/// which leaked one API key per mapping per tick. Returning the owned key lets each call site borrow
/// it from a local that outlives the call.
pub enum MappingAuth {
    Admin,
    Key(String),
}

impl MappingAuth {
    /// The stand-in that OWNS a member mirror, or the household key for an owner mapping.
    ///
    /// A member mapping with NO key is refused rather than read with the household key: the mirror is
    /// owned by the origin's stand-in, and holding the household key is not evidence that this
    /// household may read someone else's album. The TypeScript throws here for the same reason
    /// (`readCredsFor`).
    pub fn for_mapping(state: &State, mapping: &Mapping) -> Result<MappingAuth, String> {
        if mapping.role != Role::Member {
            return Ok(MappingAuth::Admin);
        }
        mapping
            .host_slug
            .as_ref()
            .and_then(|slug| {
                state
                    .collections()
                    .contributors
                    .get(slug)
                    .map(|c| c.api_key.clone())
            })
            // Empty = the stand-in's key was never minted; that is not a key.
            .filter(|key| !key.is_empty())
            .map(MappingAuth::Key)
            .ok_or_else(|| {
                format!(
                    "mapping \"{}\" ({}) has no host key — refusing to read its mirror with the admin key",
                    mapping.album_name, mapping.id
                )
            })
    }

    /// Borrow it for one call.
    pub fn auth(&self) -> Auth<'_> {
        match self {
            MappingAuth::Admin => Auth::Admin,
            MappingAuth::Key(key) => Auth::Key(key),
        }
    }
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
    match client
        .get("/albums", &crate::immich::client::Auth::Creds(creds))
        .await
    {
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
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse().ok())
                    .or_else(|| v.as_i64())
            })
            .unwrap_or(0);
    }
    Some(out)
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
        assert_eq!(
            creds.headers.get("cookie").unwrap(),
            "immich_access_token=abc"
        );
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

    fn mapping(role: Role, host_slug: Option<&str>) -> Mapping {
        let mut m: Mapping = serde_json::from_value(serde_json::json!({
            "id": "m1",
            "role": if role == Role::Member { "member" } else { "owner" },
            "albumId": "album-1",
            "albumName": "Holidays",
            "peer": "peer-1",
            "permissions": "view",
            "via": "link",
            "dead": false,
        }))
        .expect("a mapping as it is stored");
        m.host_slug = host_slug.map(str::to_string);
        m
    }

    /// A booted state with one contributor key — `State::boot` rather than a literal, because the
    /// store is private to `state` and a test elsewhere has no business assembling one.
    fn state_with_one_key() -> std::sync::Arc<State> {
        crate::config::install_test_config();
        let state = State::boot().expect("boot");
        let mut contributors = HashMap::new();
        contributors.insert(
            "person-abc".to_string(),
            crate::store::Contributor {
                user_id: "u1".into(),
                api_key: "stand-in-key".into(),
                password: None,
                avatar_done: true,
                via_peer: None,
                peer_user_id: None,
                home_peer: None,
            },
        );
        // Not provisioned yet: an empty id and an empty key, the shape a mid-provisioning crash
        // persists. The mirror it owns must read as keyless, not as a key that is "".
        contributors.insert(
            "person-empty".to_string(),
            crate::store::Contributor {
                user_id: String::new(),
                api_key: String::new(),
                password: None,
                avatar_done: false,
                via_peer: None,
                peer_user_id: None,
                home_peer: None,
            },
        );
        state.collections().contributors = contributors;
        state
    }

    #[test]
    fn a_member_mirror_is_read_with_the_key_that_owns_it() {
        let state = state_with_one_key();
        let creds = MappingAuth::for_mapping(&state, &mapping(Role::Member, Some("person-abc")))
            .expect("the stand-in's key");
        assert!(matches!(creds, MappingAuth::Key(ref k) if k == "stand-in-key"));
        match creds.auth() {
            Auth::Key(k) => assert_eq!(k, "stand-in-key"),
            _ => panic!("a member mirror must not be read as the household"),
        }
    }

    #[test]
    fn a_member_mirror_with_no_key_is_refused_rather_than_borrowing_the_admin_key() {
        // The unsafe direction: holding the household key is not evidence that this household may
        // read someone else's album.
        let state = state_with_one_key();
        assert!(
            MappingAuth::for_mapping(&state, &mapping(Role::Member, None)).is_err(),
            "no key means refuse, not fall back"
        );
        assert!(
            MappingAuth::for_mapping(&state, &mapping(Role::Member, Some("person-gone"))).is_err(),
            "a key for an account we do not hold is not a key"
        );
        assert!(
            MappingAuth::for_mapping(&state, &mapping(Role::Member, Some("person-empty"))).is_err(),
            "an empty key is not provisioned, not a key that is \"\""
        );
    }

    #[test]
    fn an_owner_mapping_reads_as_the_household() {
        let state = state_with_one_key();
        let creds = MappingAuth::for_mapping(&state, &mapping(Role::Owner, None)).expect("admin");
        assert!(matches!(creds.auth(), Auth::Admin));
    }
}
