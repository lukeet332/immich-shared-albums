//! immich/admin_key.rs — the admin key's required scopes, and the boot check that verifies them. See ARCHITECTURE.md.

use crate::immich::client::{Auth, Client};

/// The full set the sidecar exercises on the admin account. Deliberately absent: every asset
/// write/delete, library/backup/job/server scopes, and all `apiKey.*` — a leaked key cannot touch
/// photos, settings, or mint itself a broader key.
pub const REQUIRED_ADMIN_PERMISSIONS: [&str; 16] = [
    "adminUser.create",
    "adminUser.read",
    "adminUser.update",
    "adminUser.delete",
    "album.read",
    "albumUser.create",
    "albumUser.update",
    "albumUser.delete",
    "asset.read",
    "asset.view",
    "asset.download",
    "activity.read",
    "activity.statistics",
    "user.read",
    "userProfileImage.read",
    "sharedLink.read",
];

/// The key cannot list its own permissions (`apiKey.read` is excluded on purpose), so verification is
/// by probe: one required scope and one optional scope, each answered by a cheap GET.
///
/// Diagnostics only: it logs what an operator has to fix and never changes what the sidecar does.
pub async fn verify_admin_key_at_boot(client: &Client) {
    let admin = probe(client, "/admin/users").await;
    if admin == 403 {
        crate::log!(
            "ADMIN KEY IS MISSING REQUIRED PERMISSIONS — cross-server sharing will not work."
        );
        crate::log!(
            "Create the key on an admin account with exactly: {}",
            REQUIRED_ADMIN_PERMISSIONS.join(", ")
        );
        crate::log!(
            "(deploy/api-key.md explains each permission. \"all\" also works, with a wider blast radius.)"
        );
        return;
    }
    let system_config = probe(client, "/system-config").await;
    if system_config == 403 {
        crate::log!(
            "admin key verified (scoped). Note: no systemConfig scope — fine unless this Immich is OAuth-only, which needs systemConfig.read+update to mint bot keys."
        );
        return;
    }
    if admin == 200 {
        crate::log!("admin key verified.");
    }
}

/// The status the admin key gets for one path, or 0 when Immich could not be reached at all —
/// "unreachable" is not this check's business, and startup retries elsewhere.
async fn probe(client: &Client, path: &str) -> u16 {
    match client.get(path, &Auth::Admin).await {
        Ok(_) => 200,
        Err(e) if e.status != 0 => e.status,
        Err(_) => 0,
    }
}
