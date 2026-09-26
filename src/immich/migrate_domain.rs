//! immich/migrate_domain.rs — one-time, idempotent rename of bot accounts onto the current email domain. See ARCHITECTURE.md.
//!
//! When the bot email domain changes, existing accounts keep their old address — they are resolved by
//! state key (person id), not email, so nothing breaks and no duplicate is created. But the old
//! address is what a human sees in Immich's People list and album picker, so on boot any bot account
//! still on a legacy domain is renamed to the same local-part on the current domain.
//!
//! Safe by construction: only accounts whose email matches a legacy domain are touched, only the
//! domain half changes, and re-running finds none. Best-effort — a failure on one account is logged
//! and skipped, never fatal to boot.

use crate::config::{LEGACY_UTILITY_DOMAINS, UTILITY_EMAIL_DOMAIN};
use crate::immich::client::{Auth, Client};
use serde_json::json;

pub async fn migrate_utility_domain(client: &Client) {
    let users = match client.get("/admin/users", &Auth::Admin).await {
        Ok(Some(users)) => users,
        Ok(None) => return,
        Err(e) => {
            crate::log!("utility-domain migration skipped (cannot list users): {e}");
            return;
        }
    };
    // Active accounts only: soft-deleted bots are already hidden from pickers and purge on their own,
    // so renaming them buys nothing and can error on an account that is going away.
    let stale: Vec<(String, String)> = users
        .as_array()
        .map(|users| {
            users
                .iter()
                .filter_map(|u| {
                    let id = u.get("id").and_then(|v| v.as_str())?;
                    let email = u.get("email").and_then(|v| v.as_str())?;
                    let local_part = email.split('@').next()?;
                    let on_legacy = LEGACY_UTILITY_DOMAINS
                        .iter()
                        .any(|domain| email.ends_with(&format!("@{domain}")));
                    on_legacy.then(|| {
                        (id.to_string(), format!("{local_part}@{UTILITY_EMAIL_DOMAIN}"))
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if stale.is_empty() {
        return;
    }
    let mut renamed = 0usize;
    for (id, email) in &stale {
        let body = json!({ "email": email });
        match client
            .json(reqwest::Method::PUT, &format!("/admin/users/{id}"), &Auth::Admin, Some(&body))
            .await
        {
            Ok(_) => renamed += 1,
            Err(e) => crate::log!("utility-domain migration: could not rename {email}: {e}"),
        }
    }
    if renamed > 0 {
        crate::log!(
            "utility-domain migration: renamed {renamed} bot account(s) to @{UTILITY_EMAIL_DOMAIN}"
        );
    }
}

#[cfg(test)]
mod tests {
    use crate::config::{LEGACY_UTILITY_DOMAINS, UTILITY_EMAIL_DOMAIN};

    #[test]
    fn only_a_legacy_domain_is_the_migrations_business() {
        let on_legacy = |email: &str| {
            LEGACY_UTILITY_DOMAINS.iter().any(|domain| email.ends_with(&format!("@{domain}")))
        };
        // The accounts this exists for: one still on a domain the addon used to write.
        assert!(on_legacy(&format!("person-abc@{}", LEGACY_UTILITY_DOMAINS[0])));
        // Already current — re-running must find none.
        assert!(!on_legacy(&format!("person-abc@{UTILITY_EMAIL_DOMAIN}")));
        // A HUMAN's address must never be renamed, whatever else changes.
        assert!(!on_legacy("someone@example.com"));
        // Nothing about a domain match may be a substring match on the local part.
        assert!(!on_legacy(&format!("{}@example.com", LEGACY_UTILITY_DOMAINS[0])));
    }
}
