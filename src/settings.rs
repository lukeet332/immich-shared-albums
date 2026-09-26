/** settings.rs — the `settings` kv row, in one place. See ARCHITECTURE.md. */
use crate::store::{Store, StoreError};

/// How long a minted pairing link stays redeemable. The ticket itself is shown exactly once and
/// only its hash persists, so this is the whole lifetime of the secret.
pub const TTL_MINUTES_MIN: i64 = 5;
pub const TTL_MAX_MINUTES: i64 = 24 * 60;
pub const DEFAULT_TTL_MINUTES: i64 = 15;

/// The admin-configurable panel settings. One owner for the whole `settings` row, because the row
/// is written as a unit and a second reader of it would drift from this one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Governs the whole share-link capability: off means every `/share/*` request passes straight
    /// through AND the peer route that redeems an invite answers 403. Hiding the card without
    /// refusing the join would be a setting that lies.
    pub share_link_join: bool,
    pub pairing_ttl_minutes: i64,
    /// Store mirrored photos as full local copies instead of hotlink stubs.
    pub store_shared_assets_locally: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            share_link_join: true,
            pairing_ttl_minutes: DEFAULT_TTL_MINUTES,
            store_shared_assets_locally: false,
        }
    }
}

impl Settings {
    /// Read the row, falling back per field. A value out of range is a DEFAULT, not an error: a
    /// hand-edited database must not stop the sidecar from booting.
    pub fn read(store: &Store) -> Settings {
        let raw = store.kv("settings").ok().flatten();
        let get = |key: &str| raw.as_ref().and_then(|v| v.get(key)).cloned();
        let ttl = get("pairing_ttl_minutes")
            .or_else(|| get("pairingTtlMinutes"))
            .and_then(|v| v.as_i64())
            .filter(|v| (TTL_MINUTES_MIN..=TTL_MAX_MINUTES).contains(v))
            .unwrap_or(DEFAULT_TTL_MINUTES);
        Settings {
            // Default ON: absent is not "off".
            share_link_join: get("shareLinkJoin")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            pairing_ttl_minutes: ttl,
            store_shared_assets_locally: get("storeSharedAssetsLocally")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        }
    }

    /// Write the whole row, preserving the camelCase member names the TypeScript reads.
    pub fn write(&self, store: &Store) -> Result<(), StoreError> {
        store.kv_set(
            "settings",
            &serde_json::json!({
                "shareLinkJoin": self.share_link_join,
                "pairingTtlMinutes": self.pairing_ttl_minutes,
                "storeSharedAssetsLocally": self.store_shared_assets_locally,
            }),
        )
    }

    /// Clamp and validate a requested TTL, as the panel route does.
    pub fn ttl_is_valid(minutes: i64) -> bool {
        (TTL_MINUTES_MIN..=TTL_MAX_MINUTES).contains(&minutes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn defaults_are_on_for_sharing_and_off_for_local_copies() {
        let s = Settings::read(&store());
        assert!(s.share_link_join, "share links default ON");
        assert_eq!(s.pairing_ttl_minutes, DEFAULT_TTL_MINUTES);
        assert!(!s.store_shared_assets_locally, "local copies default OFF");
    }

    #[test]
    fn a_round_trip_preserves_every_field() {
        let store = store();
        let wanted = Settings {
            share_link_join: false,
            pairing_ttl_minutes: 60,
            store_shared_assets_locally: true,
        };
        wanted.write(&store).unwrap();
        assert_eq!(Settings::read(&store), wanted);
    }

    #[test]
    fn an_out_of_range_ttl_falls_back_rather_than_failing_to_boot() {
        let store = store();
        store
            .kv_set(
                "settings",
                &serde_json::json!({"pairingTtlMinutes": 99999, "shareLinkJoin": true}),
            )
            .unwrap();
        assert_eq!(
            Settings::read(&store).pairing_ttl_minutes,
            DEFAULT_TTL_MINUTES
        );
        assert!(Settings::ttl_is_valid(5));
        assert!(Settings::ttl_is_valid(1440));
        assert!(!Settings::ttl_is_valid(4));
        assert!(!Settings::ttl_is_valid(1441));
    }

    #[test]
    fn the_written_row_uses_the_member_names_the_typescript_reads() {
        let store = store();
        Settings::default().write(&store).unwrap();
        let raw = store.kv("settings").unwrap().unwrap();
        // The panel's JS and the TypeScript routes read these exact camelCase keys.
        assert!(raw.get("shareLinkJoin").is_some());
        assert!(raw.get("pairingTtlMinutes").is_some());
        assert!(raw.get("storeSharedAssetsLocally").is_some());
    }
}
