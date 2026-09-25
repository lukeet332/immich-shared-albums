/** immich/contributors.rs — one Immich account per remote person, and the membership rules. See PORT.md. */
use crate::config::{bot_prefix, cfg, is_utility_email, UTILITY_EMAIL_DOMAIN, UTILITY_SUFFIX};
use base64::Engine as _;
use crate::immich::client::{Auth, Client};
use crate::state::State;
use crate::store::Contributor;
use serde_json::{json, Value};

/// The scopes a per-person stand-in gets. Never admin, never `all`, and deliberately WITHOUT
/// `apiKey.create`: a bot key can do its listed actions and no more, so a stolen one cannot widen
/// itself.
pub const UTILITY_PERMISSIONS: [&str; 22] = [
    "asset.upload",
    "asset.read",
    "asset.update",
    "asset.delete",
    "asset.download",
    "album.create",
    "album.read",
    "album.update",
    "album.delete",
    "albumAsset.create",
    "albumAsset.delete",
    "albumUser.create",
    "albumUser.update",
    "albumUser.delete",
    "activity.create",
    "activity.read",
    "activity.delete",
    "activity.statistics",
    "user.read",
    "user.update",
    "userProfileImage.create",
    "userProfileImage.update",
];

/// What to do about an album membership, decided from facts rather than from a live call.
///
/// This is the security-critical ordering, extracted so it can be tested without a server. Getting
/// it wrong in the unsafe direction shares an album nobody offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipAction {
    /// The album could not be read, so the membership cannot be proven not to be a human's. Do not
    /// add: a blind add could later be misread as an invitation. The next cycle retries.
    CannotProve,
    /// The person is gone from an invitation album: a human REMOVED them. Do not put them back.
    Revoked,
    /// Add them. `record_first` says whether this membership is OURS to disown (attribution) or an
    /// invitation we must leave alone — the scanner has to read an invitation as the intent it is,
    /// or the peer is never told.
    Add { record_first: bool },
    /// Already a member; nothing to do.
    AlreadyMember,
}

/// Decide from the three facts that matter, in the order they matter.
pub fn membership_action(
    can_read_album: bool,
    already_member: bool,
    re_add_if_missing: bool,
    invitation: bool,
) -> MembershipAction {
    if !can_read_album {
        return MembershipAction::CannotProve;
    }
    if already_member {
        return MembershipAction::AlreadyMember;
    }
    if !re_add_if_missing {
        return MembershipAction::Revoked;
    }
    MembershipAction::Add { record_first: !invitation }
}

/// Who a contributor account is, and what it must be keyed on.
pub struct ContributorSpec {
    pub display_name: String,
    /// The name to write VERBATIM, instead of `display_name` plus the utility suffix. The house bot
    /// is named after the addon rather than after a person, so a suffix would be a lie; and the
    /// directory uses it to name a person after the server they were placed on.
    pub full_name: Option<String>,
    pub state_key: String,
    pub email: String,
    pub via_peer: Option<String>,
    pub peer_user_id: Option<String>,
    /// The server this person LIVES on. Set only by a directory exchange or the panel's invite —
    /// never by a ref, which proves neither what to call them nor where they live.
    pub home_peer: Option<String>,
    pub permissions: Option<Vec<String>>,
}

pub fn person_spec(display_name: &str, origin_user_id: &str) -> ContributorSpec {
    ContributorSpec {
        display_name: display_name.to_string(),
        // Keyed on the person's id on their OWN server, so the same human resolves to the same
        // account whether we meet them through a directory or a relayed photo.
        state_key: format!("{}{origin_user_id}", bot_prefix::PERSON),
        email: format!("{}{origin_user_id}@{UTILITY_EMAIL_DOMAIN}", bot_prefix::PERSON),
        full_name: None,
        via_peer: None,
        peer_user_id: Some(origin_user_id.to_string()),
        home_peer: None,
        permissions: None,
    }
}

/// A fresh secret, unpadded base64url — the shape the sidecar mints everywhere.
fn random_secret(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// The credential an album is read and written with. `None` is the household key — the album is
/// ours, so nobody's stand-in is involved.
pub fn host_auth(host_key: Option<&str>) -> Auth<'_> {
    match host_key {
        Some(key) => Auth::Key(key),
        None => Auth::Admin,
    }
}

/// Sign in as a utility account, for the one thing only a session can do: mint that account's key.
async fn login_as(client: &Client, email: &str, password: &str) -> Option<Value> {
    client
        .json(
            reqwest::Method::POST,
            "/auth/login",
            &Auth::Admin,
            Some(&json!({ "email": email, "password": password })),
        )
        .await
        .ok()
        .flatten()
}

/// `Some(true|false)` when Immich answered, `None` when it did not: a setting this code cannot read
/// must not make it borrow anything.
async fn password_login_enabled(client: &Client) -> Option<bool> {
    let config = client
        .get("/system-config", &Auth::Admin)
        .await
        .ok()
        .flatten()?;
    config
        .pointer("/passwordLogin/enabled")
        .and_then(|v| v.as_bool())
}

/// Borrow the setting, so a key can be minted for an account that has only a password.
async fn enable_password_login(client: &Client) -> bool {
    let Ok(Some(config)) = client.get("/system-config", &Auth::Admin).await else {
        return false;
    };
    let mut updated = config;
    if let Some(flag) = updated.pointer_mut("/passwordLogin/enabled") {
        *flag = json!(true);
    }
    client
        .json(
            reqwest::Method::PUT,
            "/system-config",
            &Auth::Admin,
            Some(&updated),
        )
        .await
        .is_ok()
}

/// Give it back. Only ever reached after `enable_password_login` succeeded AND a login was refused
/// while the setting read disabled — never from a read on its own.
async fn restore_password_login_off(client: &Client) {
    let Ok(Some(config)) = client.get("/system-config", &Auth::Admin).await else {
        return;
    };
    let mut updated = config;
    if let Some(flag) = updated.pointer_mut("/passwordLogin/enabled") {
        *flag = json!(false);
    }
    if client
        .json(
            reqwest::Method::PUT,
            "/system-config",
            &Auth::Admin,
            Some(&updated),
        )
        .await
        .is_err()
    {
        crate::log!("WARNING: could not restore passwordLogin=disabled");
    }
}

/// One provision per EMAIL at a time.///
/// Two loops race to place the same person the first time they are seen — the watcher materialising a
/// ref while the invite loop creates an invite target, or a comment arriving for the same album. Both
/// find no account, both `POST /admin/users`, and Immich answers the loser `duplicate key value
/// violates unique constraint "user_email_uq"`. The loser's recovery path then RESETS that account's
/// password, which is the password the winner is still logging in with, so the winner fails with
/// "login failed for … — will retry" on a join, an invite or a comment someone just triggered.
/// Serialising on the email makes the second caller find a usable account instead of clobbering it.
///
/// Keyed on the EMAIL, not the state key: the email is what Immich enforces uniqueness on.
fn provision_lock(email: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
    > = std::sync::OnceLock::new();
    let locks = LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut locks = locks.lock().unwrap();
    locks.entry(email.to_string()).or_default().clone()
}

/// Provision or heal one stand-in account, and return it holding a usable key.
pub async fn ensure_utility_user(
    state: &State,
    client: &Client,
    spec: &ContributorSpec,
) -> Result<Contributor, String> {
    // Held for the whole provision and released when this returns. A `tokio` mutex on purpose: the
    // guard lives across Immich calls, and a `std` one would block a runtime worker.
    let _provision = provision_lock(&spec.email).lock_owned().await;
    let wanted_name = spec
        .full_name
        .clone()
        .unwrap_or_else(|| format!("{}{UTILITY_SUFFIX}", spec.display_name));
    let existing = state.collections().contributors.get(&spec.state_key).cloned();

    if let Some(existing) = existing.as_ref().filter(|c| c.api_key.is_some()) {
        // Already provisioned. Heal the records in ONE save, because a crash must never split
        // `homePeer` from the rest of the account.
        let needs_write = (spec.home_peer.is_some() && existing.home_peer != spec.home_peer)
            || (spec.via_peer.is_some() && existing.via_peer != spec.via_peer)
            || (spec.peer_user_id.is_some() && existing.peer_user_id != spec.peer_user_id);
        if needs_write {
            // SCOPED, and the scope is load-bearing: `collections()` and `Store::save()` take the
            // SAME non-reentrant `std::sync::Mutex`, so saving while the guard is alive is a
            // SELF-DEADLOCK that hangs the sidecar — every handler that touches state blocks behind
            // it, and the healthcheck goes unhealthy. Reachable the first time any contributor's
            // record needs healing, which is rare enough that it survived until the directory lane
            // healed one for every person on every peer.
            {
                let mut collections = state.collections();
                if let Some(c) = collections.contributors.get_mut(&spec.state_key) {
                    // Only a directory may say where someone lives: a relayed ref knows the person's
                    // id but not their server, and moving `homePeer` on a ref is what would hand an
                    // album shared with a person at D to the C it travelled through.
                    if spec.home_peer.is_some() {
                        c.home_peer = spec.home_peer.clone();
                    }
                    if spec.via_peer.is_some() {
                        c.via_peer = spec.via_peer.clone();
                    }
                    if spec.peer_user_id.is_some() {
                        c.peer_user_id = spec.peer_user_id.clone();
                    }
                }
            }
            let _ = state.save();
        }

        // Heal a stale DISPLAY NAME. Accounts created before the naming rule carry forms like
        // "Shared · Legacy Name", and nothing else would ever correct them.
        //
        // The directory OWNS the name of anyone it has placed: it is the only caller that knows
        // which server to name. An attribution ref arriving later must not rename them back to the
        // generic suffix, or the two overwrite each other on every poll. (`fullName` is how the
        // directory states a name outright; it belongs to the invites feature, so until that lands
        // the guard is simply "a directory has placed them".)
        // An account with a key but no id is mid-provision; the retry that finishes it heals the
        // name too, so there is nothing to do here.
        // A directory that PLACED this person and named them outright owns that name; an
        // attribution ref must not rename them back to the generic suffix on every poll.
        let directory_owns_name = existing.home_peer.is_some() && spec.full_name.is_none();
        if let (false, Some(user_id)) = (directory_owns_name, existing.user_id.clone()) {
            // A SHORT ttl, because this is a correction and correcting from a stale read is a
            // contradiction. With the 10s attribution TTL, a rename made between two materialises
            // is invisible to the next one: the cache still holds the old name, it compares equal to
            // the wanted one, and the heal silently does nothing until some LATER materialise
            // happens to fall outside the window. Measured on the rig: a heal that should have run
            // within seconds fired 160 s later, only because that was the next ref for that person.
            let users = crate::immich::client::users_by_id(client, 1_000).await;
            let current = users.get(&user_id).map(|u| u.name.clone());
            if let Some(current) = current.filter(|n| !n.is_empty() && *n != wanted_name) {
                let body = json!({ "name": wanted_name });
                if client
                    .json(
                        reqwest::Method::PUT,
                        &format!("/admin/users/{user_id}"),
                        &Auth::Admin,
                        Some(&body),
                    )
                    .await
                    .is_ok()
                {
                    crate::immich::client::note_user_renamed(&user_id, &wanted_name);
                    crate::log!("healed utility user name: \"{current}\" -> \"{wanted_name}\"");
                }
                // A failure is cosmetic: the account works, and the next cycle tries again.
            }
        }
        return Ok(existing.clone());
    }

    // Creating an account is a commitment on behalf of a linked server. If that server is being
    // unlinked — or already is — the caller is a materialisation that outran the teardown, and
    // finishing it would leave an orphan bot account with a live key for a server we no longer
    // trust. Refuse; the mapping it served is gone, so nothing retries.
    let via = spec.home_peer.clone().or(spec.via_peer.clone());
    if let Some(via) = via.as_deref() {
        if !state.peer_is_linked(Some(via)) {
            return Err(format!("not provisioning \"{wanted_name}\": its server is no longer linked"));
        }
    }

    // Reuse a persisted password if there is one (a partial provision retries), else mint fresh.
    let password = existing
        .as_ref()
        .and_then(|c| c.password.clone())
        .unwrap_or_else(|| random_secret(18));

    let created = client
        .post("/admin/users", &Auth::Admin, &json!({
            "email": spec.email,
            "name": wanted_name,
            "password": password,
        }))
        .await;

    let user_id = match created {
        Ok(Some(user)) => user.get("id").and_then(|v| v.as_str()).map(str::to_string),
        // The account may already exist as a SOFT-DELETED one from a previous teardown.
        _ => match find_user_by_email(client, &spec.email, true).await {
            Some(user) => {
                let id = user.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                if user.get("deletedAt").map(|d| !d.is_null()).unwrap_or(false) {
                    let _ = client
                        .post(&format!("/admin/users/{id}/restore"), &Auth::Admin, &json!({}))
                        .await;
                    crate::log!("restored soft-deleted utility user {}", spec.email);
                }
                // An admin reset also clears shouldChangePassword so programmatic login works.
                let _ = client
                    .json(
                        reqwest::Method::PUT,
                        &format!("/admin/users/{id}"),
                        &Auth::Admin,
                        Some(&json!({ "password": password, "shouldChangePassword": false, "name": wanted_name })),
                    )
                    .await;
                Some(id)
            }
            None => None,
        },
    };
    let Some(user_id) = user_id else {
        return Err(format!("cannot create or find contributor user {}", spec.email));
    };

    // Mint the key by signing in as the account, and borrow a password-login window ONLY on
    // EVIDENCE: the login is tried first, and the instance's setting is read only once that attempt
    // has been refused.
    //
    // Reading the setting up front is what made this destructive. Immich caches `system-config`, so
    // a read can say "disabled" for a while after an operator (or the panel) enabled it — the
    // addon would then "borrow" it and its restore would write `disabled` back over a change it
    // never made, leaving a human unable to sign in. The rig caught it: a contributor provisioned
    // on C in the same second the browser lane switched password login on, and every sign-in for
    // the next minute answered `Password login has been disabled`.
    let login = login_as(client, &spec.email, &password).await;
    let login = match login {
        Some(login) => Some(login),
        None => {
            // Refused. Now the setting is worth reading, and a genuine OAuth-only instance is the
            // only case that reaches the borrow.
            if password_login_enabled(client).await == Some(false)
                && enable_password_login(client).await
            {
                let retried = login_as(client, &spec.email, &password).await;
                restore_password_login_off(client).await;
                retried
            } else {
                None
            }
        }
    };

    let Some(token) = login.as_ref().and_then(|l| l.get("accessToken")).and_then(|v| v.as_str()) else {
        return Err(format!("login failed for {} — will retry", spec.email));
    };

    // Mint the key as the account itself, with exactly the listed scopes.
    let permissions: Vec<String> = spec
        .permissions
        .clone()
        .unwrap_or_else(|| UTILITY_PERMISSIONS.iter().map(|p| p.to_string()).collect());
    let key_body = json!({ "name": "immich-shared-albums", "permissions": permissions });
    let minted = mint_api_key(client, token, &key_body).await;
    let Some(secret) = minted.as_ref().and_then(|k| k.get("secret")).and_then(|v| v.as_str()) else {
        return Err(format!("api-key mint failed for {} — will retry", spec.email));
    };

    // The password existed ONLY to mint that key. Roll it to a value we never keep, so the account
    // stops being sign-in-able at all: from here the sidecar holds a scoped API key and nothing
    // that can open an interactive session. A stored password would otherwise be a standing login
    // to this server, sitting in state.db, for a bot that never needs one.
    let password_retired = client
        .json(
            reqwest::Method::PUT,
            &format!("/admin/users/{user_id}"),
            &Auth::Admin,
            Some(&json!({ "password": random_secret(24), "shouldChangePassword": false })),
        )
        .await
        .is_ok();
    if !password_retired {
        crate::log!("WARNING: could not retire the login password for {}", spec.email);
    }

    if cfg().bot_quota_mb > 0 {
        let _ = client
            .json(
                reqwest::Method::PUT,
                &format!("/admin/users/{user_id}"),
                &Auth::Admin,
                Some(&json!({ "quotaSizeInBytes": cfg().bot_quota_mb * 1024 * 1024 })),
            )
            .await;
    }

    let contributor = Contributor {
        user_id: Some(user_id),
        api_key: Some(secret.to_string()),
        // Keep the password ONLY when the roll failed, so a retry can resume.
        password: if password_retired { None } else { Some(password) },
        avatar_done: existing.as_ref().map(|c| c.avatar_done).unwrap_or(false),
        via_peer: spec.via_peer.clone().or_else(|| existing.as_ref().and_then(|c| c.via_peer.clone())),
        peer_user_id: spec
            .peer_user_id
            .clone()
            .or_else(|| existing.as_ref().and_then(|c| c.peer_user_id.clone())),
        home_peer: spec.home_peer.clone().or_else(|| existing.as_ref().and_then(|c| c.home_peer.clone())),
    };
    state
        .collections()
        .contributors
        .insert(spec.state_key.clone(), contributor.clone());
    let _ = state.save();
    apply_picture_plan(client, &contributor).await;
    crate::log!(
        "provisioned utility user \"{wanted_name}\" (scoped key{})",
        if password_retired { ", no login" } else { "" }
    );
    Ok(contributor)
}

/// The picture an account of ours wears, applied. See `stand_in_picture.rs` for the rule itself.
///
/// `has_picture` is false at this call site, exactly as the TypeScript passes it: the fact is read
/// from Immich's cached user list, which a provisioning burst would race, so the plan is made from
/// the one thing that is known here — whether the account stands in for a person.
async fn apply_picture_plan(client: &Client, contributor: &Contributor) {
    let plan = crate::immich::stand_in_picture::picture_plan_for(
        contributor.peer_user_id.is_some(),
        false,
    );
    if plan == crate::immich::stand_in_picture::PicturePlan::Wear {
        give_bot_avatar(client, contributor).await;
    }
}

/// Accounts this process has already given a picture, so a provisioning burst does not upload the
/// same PNG once per ref materialised.
fn gave_picture() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static GAVE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    GAVE.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Our own face on an account of ours, once — and only on an account that IS the addon.
///
/// Best effort by design: the picture is garnish, and the account it decorates has work to do whether
/// or not it lands.
async fn give_bot_avatar(client: &Client, contributor: &Contributor) {
    let (Some(key), Some(user_id)) = (contributor.api_key.as_deref(), contributor.user_id.as_deref())
    else {
        return;
    };
    if gave_picture().lock().map(|g| g.contains(user_id)).unwrap_or(true) {
        return;
    }
    let png = crate::immich::bot_avatar::bot_avatar_png(128);
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(png)
            .file_name("immich-shared-albums.png")
            .mime_str("image/png")
            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new())),
    );
    let posted = client
        .post_multipart("/users/profile-image", &Auth::Key(key), form)
        .await;
    if posted.is_ok() {
        if let Ok(mut gave) = gave_picture().lock() {
            gave.insert(user_id.to_string());
        }
        crate::log!("gave \"{}\" the addon's own picture", &user_id[..user_id.len().min(8)]);
    }
}

/// Mint a key with the account's OWN bearer token — never the admin key. The scopes come from the
/// caller, so a bot key cannot widen itself: `apiKey.create` is not in `UTILITY_PERMISSIONS`.
async fn mint_api_key(client: &Client, token: &str, body: &Value) -> Option<Value> {
    client.post_with_bearer("/api-keys", token, body).await.ok().flatten()
}

/// The remote person's avatar, fetched from THEIR server and put on their stand-in here.
///
/// Garnish, and best effort: a stand-in with no picture wears Immich's own initial, which is honest.
/// It stops retrying only once a picture actually landed (`avatar_done`), so a peer that is down
/// costs a retry rather than the picture.
pub async fn sync_avatar(
    state: &State,
    client: &Client,
    contributor: &crate::store::Contributor,
    peer: Option<&crate::store::Peer>,
    origin_user_id: Option<&str>,
) {
    let (Some(peer), Some(origin_user_id)) = (peer, origin_user_id.filter(|id| !id.is_empty())) else {
        return;
    };
    if contributor.avatar_done {
        return;
    }
    let Some(key) = contributor.api_key.as_deref() else { return };
    let Some(transport) = crate::p2p::transport::transport() else { return };
    let path = format!("/users/{origin_user_id}/avatar");
    let (head, body) = match transport.byte_request(peer, &path, None, None).await {
        Ok(answer) => answer,
        Err(e) => {
            crate::log!("could not fetch \"{origin_user_id}\"'s picture from \"{}\": {e}", peer.name);
            return;
        }
    };
    if head.status >= 400 {
        // Not an error: most people have no picture, and their stand-in wears Immich's own initial.
        crate::trace!(
            "\"{origin_user_id}\" has no picture on \"{}\" ({})",
            peer.name,
            head.status
        );
        return;
    }
    // An avatar is not 8MB — refuse and stop, rather than retrying a peer that answers with something
    // that is not a picture.
    if body.len() > 8 * 1024 * 1024 {
        crate::log!("the picture for \"{origin_user_id}\" is over 8MB — not a picture, refusing it");
        return;
    }
    let content_type = head
        .headers
        .as_ref()
        .and_then(|h| h.get("content-type").cloned())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let part = reqwest::multipart::Part::bytes(body)
        .file_name("avatar.jpg")
        .mime_str(&content_type)
        .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()));
    let form = reqwest::multipart::Form::new().part("file", part);
    match client.post_multipart("/users/profile-image", &Auth::Key(key), form).await {
        Ok(()) => {
            // Only stop retrying once an avatar actually landed.
            mark_avatar_done(state, contributor);
            crate::log!("gave the stand-in of \"{origin_user_id}\" the picture their server has for them");
        }
        Err(e) => crate::log!("could not put \"{origin_user_id}\"'s picture on their stand-in: {e}"),
    }
}

fn mark_avatar_done(state: &State, contributor: &crate::store::Contributor) {
    let key = state
        .collections()
        .contributors
        .iter()
        .find(|(_, c)| c.user_id == contributor.user_id)
        .map(|(slug, _)| slug.clone());
    let Some(key) = key else { return };
    if let Some(live) = state.collections().contributors.get_mut(&key) {
        live.avatar_done = true;
    }
    let _ = state.save();
}

async fn find_user_by_email(client: &Client, email: &str, with_deleted: bool) -> Option<Value> {
    let path = if with_deleted { "/admin/users?withDeleted=true" } else { "/admin/users" };
    let users = client.get(path, &Auth::Admin).await.ok().flatten()?;
    users
        .as_array()?
        .iter()
        .find(|u| u.get("email").and_then(|e| e.as_str()) == Some(email))
        .cloned()
}

/// Provision the stand-in for a remote person and ensure they are a member of the album.
///
/// The membership rules are the security property; see `membership_action`.
#[allow(clippy::too_many_arguments)]
pub async fn ensure_contributor(
    state: &State,
    client: &Client,
    display_name: &str,
    album_id: &str,
    // ANY credential that can read the album and add to it. A host KEY for a mirror's stand-in, the
    // HOUSEHOLD key for an album this household owns (an owner mapping legitimately has no stand-in),
    // and the CALLER'S OWN forwarded credentials when a human is sharing their album from the panel
    // — which is the one case where the membership is their act and must be made as them.
    auth: &Auth<'_>,
    origin_user_id: Option<&str>,
    via_peer: Option<&str>,
    re_add_if_missing: bool,
    invitation: bool,
) -> Result<Contributor, String> {
    // Key on the person's id on their OWN server — required, so this is the same account the
    // directory creates rather than a second entry for one human.
    let Some(origin_user_id) = origin_user_id else {
        return Err(format!(
            "ref from \"{display_name}\" carries no contributor id — refusing a name-keyed account"
        ));
    };
    let mut spec = person_spec(display_name, origin_user_id);
    spec.via_peer = via_peer.map(str::to_string);
    let contributor = ensure_utility_user(state, client, &spec).await?;
    let Some(user_id) = contributor.user_id.clone() else {
        return Err(format!("contributor \"{display_name}\" has no user id yet — will retry"));
    };
    if contributor.api_key.is_none() {
        return Err(format!("contributor \"{display_name}\" has no API key yet — will retry"));
    }

    // Read the album AS THE HOST, to learn whether this person is already a member.
    let album = client.get_album(album_id, auth).await.ok().flatten();
    let already_member = album
        .as_ref()
        .map(|a| {
            a.get("albumUsers")
                .and_then(|u| u.as_array())
                .map(|users| {
                    users.iter().any(|au| {
                        au.pointer("/user/id").and_then(|v| v.as_str()) == Some(user_id.as_str())
                    })
                })
                .unwrap_or(false)
        })
        .unwrap_or(false);

    match membership_action(album.is_some(), already_member, re_add_if_missing, invitation) {
        MembershipAction::CannotProve => {
            // Do not add: a blind add here could later be misread as an invitation.
            return Ok(contributor);
        }
        MembershipAction::AlreadyMember => {}
        MembershipAction::Revoked => {
            crate::log!(
                "\"{display_name}\" is no longer a member of this album — not re-adding (revoked)"
            );
        }
        MembershipAction::Add { record_first } => {
            // RECORD BEFORE THE ADD. A crash between these two lines must leave a record with no
            // membership (we ignore a real invitation) rather than a membership with no record
            // (which reads as human intent and shares an album nobody offered).
            if record_first {
                let _ = state.store.added_record(album_id, &user_id);
            }
            let body = json!({ "albumUsers": [{ "userId": user_id, "role": "editor" }] });
            if let Err(e) = client
                .json(
                    reqwest::Method::PUT,
                    &format!("/albums/{album_id}/users"),
                    auth,
                    Some(&body),
                )
                .await
            {
                crate::log!("could not add \"{display_name}\" to the album: {e} — will retry");
            }
        }
    }
    Ok(contributor)
}

/// Is this one of our own bot accounts? The single source of truth lives in config.
pub fn is_bot_email(email: Option<&str>) -> bool {
    is_utility_email(email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisioning_is_serialised_per_person_email() {
        // The lock exists so two loops cannot create one account at the same time, so it must be the
        // SAME lock for one email and DIFFERENT locks for two. Keying it on anything else — the state
        // key, the display name — either fails to serialise the race or makes unrelated people wait
        // on each other's Immich calls.
        let first = provision_lock("person-1@immich-shared-albums.internal");
        let again = provision_lock("person-1@immich-shared-albums.internal");
        let other = provision_lock("person-2@immich-shared-albums.internal");
        assert!(std::sync::Arc::ptr_eq(&first, &again), "one person's email shares one lock");
        assert!(!std::sync::Arc::ptr_eq(&first, &other), "different people must not serialise each other");
    }

    #[test]
    fn an_unreadable_album_means_do_not_add() {
        // The unsafe direction here is the opposite one: adding blind could later be misread as an
        // invitation, so an unreadable album must fail towards under-sharing.
        assert_eq!(
            membership_action(false, false, true, false),
            MembershipAction::CannotProve
        );
        // Even an INVITATION is not added when the album cannot be read.
        assert_eq!(
            membership_action(false, false, true, true),
            MembershipAction::CannotProve
        );
        // And an unreadable album is not "already a member" either.
        assert_eq!(
            membership_action(false, true, true, false),
            MembershipAction::CannotProve
        );
    }

    #[test]
    fn a_missing_member_on_an_invitation_album_is_REVOKED_not_re_added() {
        // A human removed them. Putting them back would undo a deliberate act.
        assert_eq!(
            membership_action(true, false, false, false),
            MembershipAction::Revoked
        );
        assert_eq!(
            membership_action(true, false, false, true),
            MembershipAction::Revoked
        );
    }

    #[test]
    fn attribution_is_recorded_as_ours_but_an_invitation_is_not_disowned() {
        // An invitation is the human's intent: recording it as ours would make the scanner read it
        // as something we did, and the peer would never be told.
        assert_eq!(
            membership_action(true, false, true, false),
            MembershipAction::Add { record_first: true }
        );
        assert_eq!(
            membership_action(true, false, true, true),
            MembershipAction::Add { record_first: false }
        );
    }

    #[test]
    fn a_person_already_in_the_album_is_left_alone() {
        assert_eq!(
            membership_action(true, true, true, false),
            MembershipAction::AlreadyMember
        );
        // Even for an invitation: re-adding would be a no-op Immich answers 200 to while silently
        // ignoring, which is exactly why the membership list is read rather than the status code.
        assert_eq!(
            membership_action(true, true, true, true),
            MembershipAction::AlreadyMember
        );
    }

    #[test]
    fn a_person_account_is_keyed_on_their_id_never_their_name() {
        let spec = person_spec("Nan", "8bd40ddf-6f6d-483c-8c1c-9edf1ac74f2d");
        assert_eq!(spec.state_key, "person-8bd40ddf-6f6d-483c-8c1c-9edf1ac74f2d");
        assert_eq!(
            spec.email,
            "person-8bd40ddf-6f6d-483c-8c1c-9edf1ac74f2d@immich-shared-albums.internal"
        );
        // Two people with the SAME display name must not collapse into one account.
        let other = person_spec("Nan", "different-id");
        assert_ne!(other.state_key, spec.state_key);
        assert_ne!(other.email, spec.email);
    }

    #[test]
    fn the_bot_namespace_is_the_documented_one() {
        assert!(person_spec("x", "id").state_key.starts_with(bot_prefix::PERSON));
        assert!(person_spec("x", "id").state_key.starts_with("person-"));
    }

    #[test]
    fn the_utility_scope_list_is_scoped_not_all() {
        // A bot key can do its listed actions and no more, so a stolen one cannot widen itself.
        assert!(!UTILITY_PERMISSIONS.contains(&"all"));
        assert!(!UTILITY_PERMISSIONS.contains(&"apiKey.create"));
        assert!(!UTILITY_PERMISSIONS.contains(&"apiKey.read"));
        // Nor can it manage users beyond its own profile.
        assert!(!UTILITY_PERMISSIONS.contains(&"adminUser.create"));
        assert!(!UTILITY_PERMISSIONS.contains(&"user.delete"));
        // It CAN upload and own assets, which is its whole job.
        assert!(UTILITY_PERMISSIONS.contains(&"asset.upload"));
        assert!(UTILITY_PERMISSIONS.contains(&"albumAsset.create"));
    }

    #[test]
    fn a_minted_secret_is_unpadded_base64url() {
        let secret = random_secret(18);
        assert_eq!(secret.len(), 24, "18 bytes is 24 base64url characters");
        assert!(!secret.contains('='), "unpadded");
        assert!(!secret.contains('+') && !secret.contains('/'), "url-safe");
        assert_ne!(secret, random_secret(18), "each is fresh");
    }
}
