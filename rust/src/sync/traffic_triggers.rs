//! sync/traffic_triggers.rs — what a request through the Immich proxy tells us to do, pure. See PORT.md.

/// What a request means for the work this sidecar does in the background.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrafficTrigger {
    /// Something the person owns may have changed: read their albums and offer them again.
    Index,
    /// A person arrived (a sign-in, or the session check every client opens with).
    Session,
    /// A comment was written — push it now rather than at the next comment tick.
    Comment,
}

fn is_write(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

/// Which requests are worth acting on — measured, not guessed.
///
/// A session on Immich is dozens of `/api` calls and the overwhelming majority are the byte path
/// (`/api/assets/…` for every thumbnail on screen), which cannot change an album list or a comment.
/// Acting on all of them would put a credential fingerprint in front of every photo the proxy streams;
/// this costs one string comparison on requests that cannot matter.
pub fn traffic_trigger_for(method: &str, path: &str) -> Option<TrafficTrigger> {
    let verb = method.to_ascii_uppercase();
    // Anything that WRITES under /albums can change what this person owns. Named as one rule rather
    // than per route, because Immich has grown these over time and a missed one is a silent stale
    // index.
    if is_write(&verb) && (path == "/api/albums" || path.starts_with("/api/albums/")) {
        return Some(TrafficTrigger::Index);
    }
    if verb == "POST" && path == "/api/activities" {
        return Some(TrafficTrigger::Comment);
    }
    if verb == "POST" && path == "/api/auth/login" {
        return Some(TrafficTrigger::Session);
    }
    if verb == "GET" && path == "/api/users/me" {
        return Some(TrafficTrigger::Session);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_album_write_is_the_index_changing() {
        assert_eq!(traffic_trigger_for("POST", "/api/albums"), Some(TrafficTrigger::Index));
        assert_eq!(traffic_trigger_for("PUT", "/api/albums/abc/assets"), Some(TrafficTrigger::Index));
        assert_eq!(traffic_trigger_for("DELETE", "/api/albums/abc"), Some(TrafficTrigger::Index));
        // A READ of the same path changes nothing.
        assert_eq!(traffic_trigger_for("GET", "/api/albums/abc"), None);
    }

    #[test]
    fn the_byte_path_is_deliberately_not_a_trigger() {
        // Every thumbnail on screen goes through here; a credential fingerprint in front of it is the
        // cost this rule exists to avoid.
        assert_eq!(traffic_trigger_for("GET", "/api/assets/abc/thumbnail"), None);
        assert_eq!(traffic_trigger_for("GET", "/api/search/metadata"), None);
    }

    #[test]
    fn a_comment_and_a_sign_in_are_the_other_two() {
        assert_eq!(traffic_trigger_for("POST", "/api/activities"), Some(TrafficTrigger::Comment));
        assert_eq!(traffic_trigger_for("POST", "/api/auth/login"), Some(TrafficTrigger::Session));
        assert_eq!(traffic_trigger_for("GET", "/api/users/me"), Some(TrafficTrigger::Session));
    }
}
