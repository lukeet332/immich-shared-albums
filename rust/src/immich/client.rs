/** immich/client.rs — the local Immich REST client: one wrapper every read and write goes through. See PORT.md. */
use crate::config::cfg;
use crate::immich::access::Creds;
use serde_json::Value;

/// How long any single Immich call may take before it is abandoned.
const IMMICH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// A failed Immich call. The status is a FIELD rather than text to be pattern-matched: the
/// TypeScript classifies retryable failures with a regex on the message, which is a contract nobody
/// can see and every refactor can break.
#[derive(Debug, Clone)]
pub struct ImmichError {
    pub path: String,
    pub status: u16,
    pub body: String,
}

impl ImmichError {
    pub fn is_not_found(&self) -> bool {
        self.status == 404
    }
    pub fn is_forbidden(&self) -> bool {
        self.status == 403
    }
    /// This credential cannot see the thing it asked for. Immich answers 404 for an asset that is
    /// gone, but 400 `Not found or no asset.read access` for one that exists and belongs to someone
    /// else, so a caller probing for VISIBILITY must read every 4xx as "cannot see" — matching only
    /// 404 makes an asset owned by another account look like a hard failure.
    pub fn is_not_visible(&self) -> bool {
        (400..500).contains(&self.status)
    }
    /// The message shape the TypeScript produces, so logs read the same.
    pub fn message(&self) -> String {
        format!("immich {} -> {} {}", self.path, self.status, self.body)
    }
}

impl std::fmt::Display for ImmichError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message())
    }
}
impl std::error::Error for ImmichError {}

/// Which credential makes a call. A closed set, so "both a key and forwarded creds" and "neither"
/// are unrepresentable — reading an album with the admin key when its stand-in key was needed is
/// silent in Immich (`400 Not found or no album.read access`), not loud.
pub enum Auth<'a> {
    /// The household's own configured key.
    Admin,
    /// A specific key, e.g. a bot account's.
    Key(&'a str),
    /// A caller's own forwarded credential.
    Creds(&'a Creds),
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    admin_key: String,
}

/// The client the SERVER serves through. One connection pool for the process, because the byte
/// interceptor runs once per thumbnail on a page: building a pool per call means a fresh TCP
/// handshake to Immich for every tile.
///
/// Boot-scoped, so it reads `cfg()` on first use — tests that install their own config must keep
/// using `Client::new()`, which is why this is not the default constructor.
static SHARED: std::sync::OnceLock<Client> = std::sync::OnceLock::new();

pub fn shared() -> &'static Client {
    SHARED.get_or_init(Client::new)
}

/// Refuse a path that already carries the `/api` prefix.
///
/// `base` is `{ISA_IMMICH_URL}/api`, so a caller who passes `/api/…` builds `/api/api/…` — which
/// Immich answers `404 Cannot POST /api/api/...`, i.e. a request that looks like a missing feature
/// rather than a mistake in this file's callers. It cost one debugging round on the avatar upload
/// before the log line naming the URL existed; this refuses it in one line instead.
fn refuse_doubled_api_prefix(path: &str) -> Result<(), ImmichError> {
    if path.starts_with("/api/") || path == "/api" {
        return Err(ImmichError {
            path: path.to_string(),
            status: 0,
            body: format!(
                "path \"{path}\" already starts with /api — it is relative to {{url}}/api"
            ),
        });
    }
    Ok(())
}

impl Client {
    pub fn new() -> Self {
        Client {
            http: reqwest::Client::builder()
                .timeout(IMMICH_DEADLINE)
                .build()
                .unwrap_or_default(),
            base: format!("{}/api", cfg().immich_url.trim_end_matches('/')),
            admin_key: cfg().api_key.clone(),
        }
    }

    fn identity(&self, auth: &Auth<'_>) -> Vec<(String, String)> {
        match auth {
            Auth::Admin => vec![("x-api-key".into(), self.admin_key.clone())],
            Auth::Key(key) => vec![("x-api-key".into(), (*key).to_string())],
            Auth::Creds(creds) => creds
                .headers
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }

    /// The raw response, for callers that need to stream a body (bytes) rather than parse JSON.
    pub async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        auth: &Auth<'_>,
        extra_headers: &[(String, String)],
    ) -> Result<reqwest::Response, ImmichError> {
        refuse_doubled_api_prefix(path)?;
        let url = format!("{}{}", self.base, path);
        crate::trace!("immich {} {}: sending", method, path);
        let started = std::time::Instant::now();
        let mut req = self
            .http
            .request(method.clone(), &url)
            .header("Accept", "application/json");
        for (name, value) in self.identity(auth) {
            req = req.header(name, value);
        }
        for (name, value) in extra_headers {
            req = req.header(name, value);
        }
        let response = req.send().await.map_err(|e| ImmichError {
            path: path.to_string(),
            status: 0,
            body: e.to_string(),
        })?;
        crate::trace!(
            "immich {} {}: {} ({}ms)",
            method,
            path,
            response.status().as_u16(),
            started.elapsed().as_millis()
        );
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ImmichError {
                path: path.to_string(),
                status,
                body,
            });
        }
        Ok(response)
    }

    /// `204` and an empty body are both `None`, exactly as the TypeScript returns `null`.
    pub async fn json(
        &self,
        method: reqwest::Method,
        path: &str,
        auth: &Auth<'_>,
        body: Option<&Value>,
    ) -> Result<Option<Value>, ImmichError> {
        refuse_doubled_api_prefix(path)?;
        let extra: Vec<(String, String)> = match body {
            Some(_) => vec![("Content-Type".into(), "application/json".into())],
            None => vec![],
        };
        let url = format!("{}{}", self.base, path);
        let mut req = self
            .http
            .request(method, &url)
            .header("Accept", "application/json");
        for (name, value) in self.identity(auth) {
            req = req.header(name, value);
        }
        for (name, value) in &extra {
            req = req.header(name, value);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let response = req.send().await.map_err(|e| ImmichError {
            path: path.to_string(),
            status: 0,
            body: e.to_string(),
        })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            return Err(ImmichError {
                path: path.to_string(),
                status,
                body: text,
            });
        }
        if response.status().as_u16() == 204 {
            return Ok(None);
        }
        let text = response.text().await.unwrap_or_default();
        if text.is_empty() {
            return Ok(None);
        }
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| ImmichError {
                path: path.to_string(),
                status: 200,
                body: e.to_string(),
            })
    }

    /// A call made with an OAuth bearer token rather than a key — how a bot mints its OWN API key,
    /// which is the one route that must not be reachable with the admin key.
    pub async fn post_with_bearer(
        &self,
        path: &str,
        token: &str,
        body: &Value,
    ) -> Result<Option<Value>, ImmichError> {
        let url = format!("{}{}", self.base, path);
        let response = self
            .http
            .post(&url)
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {token}"))
            .json(body)
            .send()
            .await
            .map_err(|e| ImmichError {
                path: path.to_string(),
                status: 0,
                body: e.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ImmichError {
                path: path.to_string(),
                status,
                body,
            });
        }
        let text = response.text().await.unwrap_or_default();
        if text.is_empty() {
            return Ok(None);
        }
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| ImmichError {
                path: path.to_string(),
                status: 200,
                body: e.to_string(),
            })
    }

    /// A multipart upload, with a longer budget than a JSON call: a photo takes time to send.
    pub async fn upload(
        &self,
        path: &str,
        key: &str,
        form: reqwest::multipart::Form,
    ) -> Result<Value, ImmichError> {
        refuse_doubled_api_prefix(path)?;
        let url = format!("{}{}", self.base, path);
        let response = self
            .http
            .post(&url)
            .timeout(std::time::Duration::from_secs(180))
            .header("x-api-key", key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| ImmichError {
                path: path.to_string(),
                status: 0,
                body: e.to_string(),
            })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ImmichError {
                path: path.to_string(),
                status,
                body,
            });
        }
        response.json().await.map_err(|e| ImmichError {
            path: path.to_string(),
            status: 200,
            body: e.to_string(),
        })
    }

    pub async fn get(&self, path: &str, auth: &Auth<'_>) -> Result<Option<Value>, ImmichError> {
        self.json(reqwest::Method::GET, path, auth, None).await
    }

    /// A multipart POST whose answer is read for its STATUS only.
    ///
    /// The profile-picture endpoints answer `200` with no body, so a JSON read would report a failure
    /// for an upload that worked.
    pub async fn post_multipart(
        &self,
        path: &str,
        auth: &Auth<'_>,
        form: reqwest::multipart::Form,
    ) -> Result<(), ImmichError> {
        refuse_doubled_api_prefix(path)?;
        let url = format!("{}{}", self.base, path);
        let mut request = self
            .http
            .post(&url)
            .timeout(std::time::Duration::from_secs(60))
            .multipart(form);
        for (name, value) in self.identity(auth) {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|e| ImmichError {
            path: path.to_string(),
            status: 0,
            body: e.to_string(),
        })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(ImmichError {
                path: path.to_string(),
                status,
                body,
            });
        }
        Ok(())
    }

    pub async fn post(
        &self,
        path: &str,
        auth: &Auth<'_>,
        body: &Value,
    ) -> Result<Option<Value>, ImmichError> {
        self.json(reqwest::Method::POST, path, auth, Some(body))
            .await
    }

    /// The admins' own view of an album. Used by the boot probe rather than by the read paths,
    /// which choose a credential through `access`.
    pub async fn get_album(
        &self,
        album_id: &str,
        auth: &Auth<'_>,
    ) -> Result<Option<Value>, ImmichError> {
        self.get(&format!("/albums/{album_id}?withoutAssets=true"), auth)
            .await
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_that_already_carries_api_is_refused_rather_than_doubled() {
        assert!(refuse_doubled_api_prefix("/users/profile-image").is_ok());
        assert!(refuse_doubled_api_prefix("/assets/a1/original").is_ok());
        let doubled = refuse_doubled_api_prefix("/api/users/profile-image").unwrap_err();
        assert_eq!(
            doubled.status, 0,
            "not an Immich answer — a mistake in this crate"
        );
        assert!(
            doubled.body.contains("/api"),
            "the message names the path it refused"
        );
        assert!(refuse_doubled_api_prefix("/api").is_err());
    }

    /// The distinction the purge depends on: Immich answers 400 `Not found or no asset.read access`
    /// for an asset that EXISTS but belongs to another account, and only 404 for one that is gone.
    /// Reading just 404 as "cannot see" makes every stand-in's asset look like a hard failure.
    #[test]
    fn a_read_this_credential_may_not_make_counts_as_not_visible() {
        let invisible = |status| ImmichError {
            path: "/assets/x".into(),
            status,
            body: String::new(),
        };
        assert!(
            invisible(400).is_not_visible(),
            "the no-asset.read-access answer"
        );
        assert!(invisible(403).is_not_visible());
        assert!(invisible(404).is_not_visible(), "a genuinely absent asset");
        assert!(
            !invisible(500).is_not_visible(),
            "a server fault is not a visibility answer"
        );
        assert!(
            !invisible(0).is_not_visible(),
            "a transport failure is not a visibility answer"
        );
    }

    use super::*;

    #[test]
    fn a_cache_miss_style_failure_is_classified_by_status_not_by_text() {
        // The whole point of the typed error: `/-> 404/` becomes a field comparison.
        let not_found = ImmichError {
            path: "/assets/x".into(),
            status: 404,
            body: String::new(),
        };
        assert!(not_found.is_not_found());
        assert!(!not_found.is_forbidden());
        // A body that happens to contain the word must not change the answer.
        let strange = ImmichError {
            path: "/assets/x".into(),
            status: 500,
            body: "404 Not found".into(),
        };
        assert!(!strange.is_not_found());
    }

    #[test]
    fn the_message_keeps_the_shape_the_typescript_logs() {
        let e = ImmichError {
            path: "/albums/a1".into(),
            status: 400,
            body: "{\"error\":\"x\"}".into(),
        };
        assert_eq!(e.message(), "immich /albums/a1 -> 400 {\"error\":\"x\"}");
    }
}

/// What a share link says about itself, read WITHOUT credentials: the share page is opened by
/// someone who has not signed in anywhere, and Immich answers `/shared-links/me?key=` for exactly
/// that visitor. A 2-second budget and `None` on every failure, because this is decoration on a
/// page that must still render — the album itself is behind Immich's own share link.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareMeta {
    pub album_name: Option<String>,
    pub cover_asset_id: Option<String>,
}

pub async fn public_share_link_meta(key: &str) -> Option<ShareMeta> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;
    let base = cfg().immich_url.trim_end_matches('/').to_string();
    let response = http
        .get(format!("{base}/api/shared-links/me"))
        .query(&[("key", key)])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let link: Value = response.json().await.ok()?;
    Some(ShareMeta {
        album_name: link
            .pointer("/album/albumName")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        cover_asset_id: link
            .pointer("/album/albumThumbnailAssetId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// One Immich user, as this layer needs them: a display name and whether they are one of ours.
#[derive(Debug, Clone, PartialEq)]
pub struct UserInfo {
    pub name: String,
    /// One of the accounts this addon minted. A bot's local name is decorated, so callers must
    /// strip it before the name goes on the wire.
    pub utility: bool,
}

pub type USERS = std::collections::HashMap<String, UserInfo>;

static USERS_CACHE: std::sync::RwLock<Option<(USERS, i64)>> = std::sync::RwLock::new(None);
/// A TOKIO mutex, not a std one: this guard is held across the Immich fetch, and a `std::sync`
/// guard held across an await makes the whole future non-`Send` (the compiler refuses it) and can
/// block a runtime worker. `tokio::sync::Mutex` is the primitive for exactly this.
static USERS_FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The id → user map, refreshed at most once per `max_age_ms`.
///
/// A FAILED refresh KEEPS THE STALE MAP rather than emptying it: attribution that was right a minute
/// ago is better than no attribution at all, and a transient Immich blip must not make every photo
/// suddenly look ownerless.
pub async fn users_by_id(client: &Client, max_age_ms: i64) -> USERS {
    if let Ok(cache) = USERS_CACHE.read() {
        if let Some((users, at)) = cache.as_ref() {
            if now_ms() - at <= max_age_ms {
                return users.clone();
            }
        }
    }
    // One fetch at a time: the loops all want this and a stampede buys nothing.
    let _guard = USERS_FETCH.lock().await;
    if let Ok(cache) = USERS_CACHE.read() {
        if let Some((users, at)) = cache.as_ref() {
            if now_ms() - at <= max_age_ms {
                return users.clone();
            }
        }
    }
    match client.get("/admin/users", &Auth::Admin).await {
        Ok(Some(Value::Array(rows))) => {
            let mut users = USERS::new();
            for row in rows {
                let Some(id) = row.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                users.insert(
                    id.to_string(),
                    UserInfo {
                        name: row
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        utility: crate::config::is_utility_email(
                            row.get("email").and_then(|v| v.as_str()),
                        ),
                    },
                );
            }
            if let Ok(mut cache) = USERS_CACHE.write() {
                *cache = Some((users.clone(), now_ms()));
            }
            users
        }
        // Keep the stale map.
        _ => USERS_CACHE
            .read()
            .ok()
            .and_then(|c| c.as_ref().map(|(u, _)| u.clone()))
            .unwrap_or_default(),
    }
}

/// Record a rename in the cache, so a read inside the TTL does not put the old name back.
///
/// Immich has no way to tell us "this changed", so a caller that has just renamed an account has to
/// say so — otherwise a name healed now stays wrong for every attribution drawn from the cache until
/// it expires, and a poll that heals on every cycle would look like it never worked.
pub fn note_user_renamed(user_id: &str, name: &str) {
    if let Ok(mut cache) = USERS_CACHE.write() {
        if let Some((users, _)) = cache.as_mut() {
            if let Some(user) = users.get_mut(user_id) {
                user.name = name.to_string();
            }
        }
    }
}

/// The name of a HUMAN owner, or `None` for a bot or an unknown id.
pub async fn owner_name(client: &Client, owner_id: &str) -> Option<String> {
    let users = users_by_id(client, 60_000).await;
    users
        .get(owner_id)
        .filter(|u| !u.utility)
        .map(|u| u.name.clone())
}

/// A share link by its key, or `None` when there is no such link.
pub async fn get_shared_link_by_key(client: &Client, key: &str) -> Option<Value> {
    let links = client
        .get("/shared-links", &Auth::Admin)
        .await
        .ok()
        .flatten()?;
    links
        .as_array()?
        .iter()
        .find(|l| l.get("key").and_then(|k| k.as_str()) == Some(key))
        .cloned()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A minimal valid 1x1 baseline grey JPEG. Stubs get a random tail for uniqueness — Immich dedupes
/// identical bytes per user, and every proxy must stay a DISTINCT asset.
pub const STUB_JPEG_B64: &str = concat!(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a",
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA",
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
);

pub fn stub_jpeg() -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(STUB_JPEG_B64)
        .unwrap_or_default()
}

/// The upload path. Multipart, with the filename driving Immich's type detection — so `ext` is not
/// cosmetic, it is how Immich decides whether it just received a photo or a video.
pub async fn upload_asset(
    client: &Client,
    bytes: &[u8],
    filename: &str,
    key: &str,
    taken_at: Option<&str>,
) -> Result<Value, ImmichError> {
    use sha1::{Digest, Sha1};
    let stamp = taken_at
        .map(str::to_string)
        .unwrap_or_else(crate::config::iso_now);
    let digest: String = Sha1::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let part = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str("application/octet-stream")
        .map_err(|e| ImmichError {
            path: "/assets".into(),
            status: 0,
            body: e.to_string(),
        })?;
    let form = reqwest::multipart::Form::new()
        .text("deviceAssetId", format!("isa-{digest}"))
        .text("deviceId", "immich-shared-albums")
        .text("fileCreatedAt", stamp.clone())
        .text("fileModifiedAt", stamp)
        .part("assetData", part);
    client.upload("/assets", key, form).await
}

/// File the asset into the album, with the OWNER's key.
pub async fn add_to_album(
    client: &Client,
    album_id: &str,
    asset_ids: &[String],
    key: &str,
) -> Result<Option<Value>, ImmichError> {
    client
        .json(
            reqwest::Method::PUT,
            &format!("/albums/{album_id}/assets"),
            &Auth::Key(key),
            Some(&serde_json::json!({ "ids": asset_ids })),
        )
        .await
}

/// Apply what a ref knows onto the local asset. Every field is optional and the whole call is
/// best-effort: metadata is decoration on a photo whose pixels are already correct, so a failure is
/// logged rather than failing the materialisation.
/// What a stub's description reads: the origin's own text, then the credit line — the one
/// composition everywhere a description is written, so a refresh rebuilds exactly what
/// materialise first wrote.
pub fn composed_description(reference: &crate::immich::refs::AssetRef) -> String {
    let credit = reference
        .contributor
        .display_name
        .is_empty()
        .then(String::new)
        .unwrap_or_else(|| format!("Shared by {}", reference.contributor.display_name));
    [
        reference
            .exif
            .as_ref()
            .and_then(|e| e.description.clone())
            .unwrap_or_default(),
        credit,
    ]
    .iter()
    .filter(|part| !part.is_empty())
    .cloned()
    .collect::<Vec<_>>()
    .join("\n\n")
}

pub async fn apply_ref_metadata(
    client: &Client,
    asset_id: &str,
    reference: &crate::immich::refs::AssetRef,
    key: &str,
) {
    let mut meta = serde_json::Map::new();
    if let Some(exif) = &reference.exif {
        if let (Some(lat), Some(lon)) = (exif.latitude, exif.longitude) {
            meta.insert("latitude".into(), serde_json::json!(lat));
            meta.insert("longitude".into(), serde_json::json!(lon));
        }
        if let Some(rating) = exif.rating {
            if rating != 0 {
                meta.insert("rating".into(), serde_json::json!(rating));
            }
        }
    }
    // The credit names the person, so a viewer sees who a photo came from rather than an anonymous
    // stub. A previous hop's credit line was already stripped when the ref was built.
    let description = composed_description(reference);
    if !description.is_empty() {
        meta.insert("description".into(), serde_json::json!(description));
    }
    if let Some(taken_at) = &reference.taken_at {
        meta.insert("dateTimeOriginal".into(), serde_json::json!(taken_at));
    }
    if meta.is_empty() {
        return;
    }
    if let Err(e) = client
        .json(
            reqwest::Method::PUT,
            &format!("/assets/{asset_id}"),
            &Auth::Key(key),
            Some(&Value::Object(meta)),
        )
        .await
    {
        crate::log!("metadata apply failed for {asset_id}: {e}");
    }
}
