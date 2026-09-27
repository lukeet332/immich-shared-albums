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

/// The extra scopes an OAuth-only Immich needs (password login is off, so the addon borrows a
/// window to mint bot keys — `immich/contributors.rs`). Optional on password-login installs,
/// which is why they are not in `REQUIRED_ADMIN_PERMISSIONS`.
pub const OAUTH_ONLY_PERMISSIONS: [&str; 2] = ["systemConfig.read", "systemConfig.update"];

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
            "admin key verified (scoped). Note: no {} scope — fine unless this Immich is OAuth-only, which needs it to mint bot keys.",
            OAUTH_ONLY_PERMISSIONS.join("+")
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

/// The two lists are one source of truth for the scoped key the rig provisions
/// (`demo/ci/provision-mock.sh` sums them), so a scope drifting between them would silently
/// widen or narrow the rig's key.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_oauth_only_scopes_add_to_the_required_list_rather_than_overlap_it() {
        assert!(!OAUTH_ONLY_PERMISSIONS.is_empty());
        for scope in OAUTH_ONLY_PERMISSIONS {
            assert!(
                !REQUIRED_ADMIN_PERMISSIONS.contains(&scope),
                "{scope} belongs in exactly one list"
            );
        }
        // The sum the provisioner mints: every required scope present, plus the optional pair.
        assert_eq!(
            REQUIRED_ADMIN_PERMISSIONS.len() + OAUTH_ONLY_PERMISSIONS.len(),
            18
        );
    }
}
