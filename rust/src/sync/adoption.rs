/** sync/adoption.rs — proving an album is the caller's own before it may be adopted. See ARCHITECTURE.md. */
use crate::sync::matches::normalise_album_name;
use serde_json::Value;

/// An album that may be adopted: it exists, the caller owns it, and its name is the one offered.
pub struct AdoptableAlbum {
    pub album_id: String,
    pub name: String,
}

/// Immich decides ownership and says so inside `albumUsers`; an album with no owner entry is
/// nobody's. Kept separate rather than inlined so the refusal reads as the rule it is.
fn owns_it(album: &Value, user_id: &str) -> bool {
    album
        .get("albumUsers")
        .and_then(|u| u.as_array())
        .map(|users| {
            users.iter().any(|entry| {
                entry.get("role").and_then(|r| r.as_str()) == Some("owner")
                    && entry.pointer("/user/id").and_then(|v| v.as_str()) == Some(user_id)
            })
        })
        .unwrap_or(false)
}

/// The caller's own album matching `album_name`, if they have one.
///
/// The raw album list carries the ID, which the published index deliberately does not. Ownership and
/// the name are checked HERE rather than trusted from the request: a body names an album and a
/// person, and it establishes neither.
pub fn find_adoptable_album(
    album_name: &str,
    caller_albums: &[Value],
    caller_user_id: &str,
) -> Option<AdoptableAlbum> {
    let wanted = normalise_album_name(album_name);
    if wanted.is_empty() {
        return None;
    }
    caller_albums
        .iter()
        .find(|album| {
            album.get("id").and_then(|v| v.as_str()).is_some()
                && normalise_album_name(album.get("albumName").and_then(|v| v.as_str()).unwrap_or(""))
                    == wanted
                && owns_it(album, caller_user_id)
        })
        .and_then(|album| {
            Some(AdoptableAlbum {
                album_id: album.get("id").and_then(|v| v.as_str())?.to_string(),
                name: album.get("albumName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
        })
}

/// The album a REUNION may put in place of a share's mirror.
///
/// Stricter than `find_adoptable_album` in two ways, and both are the difference between reuniting a
/// share and silently repointing it at an unrelated album:
///
/// 1. The request names the album to put in the share's place, and it must be the SAME album the
///    share is about. Without this, a request could reunite a share with any album the caller owns.
/// 2. It must not already BE the mapping's album — reuniting an album with itself is not a reunion.
pub fn can_unify_own_album(
    mapping_album_id: &str,
    mapping_album_name: &str,
    requested_album_name: &str,
    caller_albums: &[Value],
    caller_user_id: &str,
) -> Option<AdoptableAlbum> {
    if normalise_album_name(requested_album_name) != normalise_album_name(mapping_album_name) {
        return None;
    }
    let found = find_adoptable_album(mapping_album_name, caller_albums, caller_user_id)?;
    if found.album_id == mapping_album_id {
        return None; // already the mapping's album
    }
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn album(id: &str, name: &str, role: &str, owner: &str) -> Value {
        json!({
            "id": id,
            "albumName": name,
            "albumUsers": [{ "role": role, "user": { "id": owner, "name": "Someone" } }],
        })
    }

    #[test]
    fn only_an_album_the_caller_OWNS_may_be_adopted() {
        // The unsafe direction: adopting an album the caller can merely see would merge someone
        // else's album into a share.
        let albums = vec![album("a", "Holidays", "viewer", "me"), album("b", "Holidays", "owner", "someone-else")];
        assert!(find_adoptable_album("Holidays", &albums, "me").is_none());

        let owned = vec![album("c", "Holidays", "owner", "me")];
        let found = find_adoptable_album("Holidays", &owned, "me").expect("their own album");
        assert_eq!(found.album_id, "c");
    }

    #[test]
    fn the_name_is_matched_the_way_the_pairing_matched_it() {
        let albums = vec![album("a", "  Summer   Trip ", "owner", "me")];
        assert!(find_adoptable_album("summer trip", &albums, "me").is_some());
        // And not fuzzily: a different album is not this one.
        assert!(find_adoptable_album("Summer Trip 2", &albums, "me").is_none());
        assert!(find_adoptable_album("", &albums, "me").is_none());
    }

    #[test]
    fn a_reunion_must_name_the_same_album_the_share_is_about() {
        // The unsafe direction: reuniting a share with any album the caller happens to own.
        let albums = vec![album("mine", "Holidays", "owner", "me")];
        assert!(can_unify_own_album("mirror", "Holidays", "Birthdays", &albums, "me").is_none());
        assert!(can_unify_own_album("mirror", "Holidays", "holidays", &albums, "me").is_some(),
                "the name is compared the way the pairing compares it");
    }

    #[test]
    fn an_album_cannot_be_reunited_with_itself() {
        let albums = vec![album("mirror", "Holidays", "owner", "me")];
        assert!(
            can_unify_own_album("mirror", "Holidays", "Holidays", &albums, "me").is_none(),
            "that is not a reunion, it is a no-op dressed as one"
        );
    }

    #[test]
    fn an_album_with_no_owner_entry_is_nobody_s() {
        let ownerless = vec![json!({ "id": "a", "albumName": "Holidays", "albumUsers": [] })];
        assert!(find_adoptable_album("Holidays", &ownerless, "me").is_none());
    }
}
