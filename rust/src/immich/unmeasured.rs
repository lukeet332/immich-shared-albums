/** immich/unmeasured.rs — the rig's list of photos to treat as not yet measured by Immich. See PORT.md. */
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Empty in every real install. A rig fills it to reproduce the window between an upload and
/// Immich's metadata job, which is when a photo has no dimensions yet.
fn hidden() -> &'static Mutex<HashSet<String>> {
    static HIDDEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HIDDEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Whether a rig has hidden this photo's dimensions.
pub fn is_hidden_as_unmeasured(asset_id: &str) -> bool {
    hidden().lock().map(|set| set.contains(asset_id)).unwrap_or(false)
}

/// Hide or reveal one photo's dimensions, by asset id on the server being asked. Rig-only.
pub fn hide_as_unmeasured(asset_id: &str, hide: bool) {
    if let Ok(mut set) = hidden().lock() {
        if hide {
            set.insert(asset_id.to_string());
        } else {
            set.remove(asset_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hiding_is_per_asset_and_reversible() {
        assert!(!is_hidden_as_unmeasured("a"));
        hide_as_unmeasured("a", true);
        assert!(is_hidden_as_unmeasured("a"));
        assert!(!is_hidden_as_unmeasured("b"), "hiding one photo must not hide another");
        hide_as_unmeasured("a", false);
        assert!(!is_hidden_as_unmeasured("a"), "revealing must actually reveal");
    }
}
