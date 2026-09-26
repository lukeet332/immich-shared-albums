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
    /// A photo's own metadata was edited (a caption, a date, a place). None of that moves an
    /// album's `updatedAt`, so the version handshake cannot see it — the albums the photo is
    /// offered to must be told to look again, or a joiner keeps a caption its origin just fixed.
    AssetMeta,
}

fn is_write(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

/// An asset metadata edit: `PUT /api/assets/:id` and nothing else. The upload (`POST /api/assets`)
/// reaches mirrors through the album writes that follow it, and every byte or search path is a
/// GET — the deliberate no-trigger majority the tests pin.
fn is_asset_meta_edit(verb: &str, path: &str) -> bool {
    matches!(verb, "PUT" | "PATCH")
        && path
            .strip_prefix("/api/assets/")
            .map(|rest| !rest.is_empty() && !rest.contains('/'))
            .unwrap_or(false)
}

/// The id of a share link being deleted: `DELETE /api/shared-links/:id` and nothing else.
///
/// This is the one write whose trail needs the state it is about to destroy — the album it granted —
/// so the caller resolves that BEFORE the request is forwarded, while the link still exists. Pure, so
/// the shape is pinned: a delete of anything else, or the collection route, must not match.
pub fn deleted_share_link_id(method: &str, path: &str) -> Option<String> {
    if !method.eq_ignore_ascii_case("DELETE") {
        return None;
    }
    let rest = path.strip_prefix("/api/shared-links/")?;
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    Some(rest.to_string())
}

/// `DELETE /api/albums/:albumId/user/:userId` — the owner taking a person off their album.
///
/// `me` is excluded on purpose: that is a person LEAVING, which the sync already notices and records
/// as a leave. Recording it as a removal would put the wrong sentence in the album, and the two are
/// not the same event — one is the household's own act, the other the owner's.
pub fn removed_person(method: &str, path: &str) -> Option<(String, String)> {
    if !method.eq_ignore_ascii_case("DELETE") {
        return None;
    }
    let rest = path.strip_prefix("/api/albums/")?;
    let (album_id, user) = rest.split_once("/user/")?;
    if album_id.is_empty() || user.is_empty() || user.contains('/') || user == "me" {
        return None;
    }
    Some((album_id.to_string(), user.to_string()))
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
    if is_asset_meta_edit(&verb, path) {
        return Some(TrafficTrigger::AssetMeta);
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
    fn only_removing_somebody_else_is_a_removal() {
        assert_eq!(
            removed_person("DELETE", "/api/albums/alb-1/user/person-9"),
            Some(("alb-1".to_string(), "person-9".to_string()))
        );
        // Leaving is not being removed: the sync records that as a leave.
        assert_eq!(removed_person("DELETE", "/api/albums/alb-1/user/me"), None);
        // Adding is not removing, and neither is a route that only looks like this one.
        assert_eq!(removed_person("PUT", "/api/albums/alb-1/user/person-9"), None);
        assert_eq!(removed_person("DELETE", "/api/albums/alb-1/users"), None);
        assert_eq!(removed_person("DELETE", "/api/albums//user/person-9"), None);
        assert_eq!(removed_person("DELETE", "/api/albums/alb-1/user/"), None);
    }

    #[test]
    fn an_album_write_is_the_index_changing() {
        assert_eq!(
            traffic_trigger_for("POST", "/api/albums"),
            Some(TrafficTrigger::Index)
        );
        assert_eq!(
            traffic_trigger_for("PUT", "/api/albums/abc/assets"),
            Some(TrafficTrigger::Index)
        );
        assert_eq!(
            traffic_trigger_for("DELETE", "/api/albums/abc"),
            Some(TrafficTrigger::Index)
        );
        // A READ of the same path changes nothing.
        assert_eq!(traffic_trigger_for("GET", "/api/albums/abc"), None);
    }

    #[test]
    fn the_byte_path_is_deliberately_not_a_trigger() {
        // Every thumbnail on screen goes through here; a credential fingerprint in front of it is the
        // cost this rule exists to avoid.
        assert_eq!(
            traffic_trigger_for("GET", "/api/assets/abc/thumbnail"),
            None
        );
        assert_eq!(traffic_trigger_for("GET", "/api/search/metadata"), None);
    }

    #[test]
    fn a_caption_edit_is_the_asset_telling_its_albums_to_look_again() {
        assert_eq!(
            traffic_trigger_for("PUT", "/api/assets/abc123"),
            Some(TrafficTrigger::AssetMeta)
        );
        assert_eq!(
            traffic_trigger_for("PATCH", "/api/assets/abc123"),
            Some(TrafficTrigger::AssetMeta)
        );
        // The upload, byte paths and deeper routes under one asset are not metadata edits.
        assert_eq!(traffic_trigger_for("POST", "/api/assets"), None);
        assert_eq!(
            traffic_trigger_for("PUT", "/api/assets/abc/thumbnail"),
            None
        );
        assert_eq!(traffic_trigger_for("GET", "/api/assets/abc"), None);
        assert_eq!(traffic_trigger_for("PUT", "/api/assets/"), None);
    }

    #[test]
    fn a_comment_and_a_sign_in_are_the_other_two() {
        assert_eq!(
            traffic_trigger_for("POST", "/api/activities"),
            Some(TrafficTrigger::Comment)
        );
        assert_eq!(
            traffic_trigger_for("POST", "/api/auth/login"),
            Some(TrafficTrigger::Session)
        );
        assert_eq!(
            traffic_trigger_for("GET", "/api/users/me"),
            Some(TrafficTrigger::Session)
        );
    }
}
