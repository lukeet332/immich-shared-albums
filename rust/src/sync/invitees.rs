//! sync/invitees.rs — who should be on a mirror, as pure set arithmetic. See PORT.md.
//!
//! Extracted from `sync_mirror_members` so it can be tested without a container. This is the only
//! code path that removes a real person from a real album, so it is worth being able to check in
//! milliseconds rather than in a seven-minute e2e run.

use crate::store::{Mapping, Role};

/// What one pass of the invitee list changes on a mirror.
#[derive(Debug, PartialEq, Eq)]
pub struct InviteeDiff {
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

/// Is this an invitation-created mirror whose album the origin no longer offers?
///
/// Scoped to `via == invite` on purpose: a link-redeemed mirror has its own lifecycle through native
/// leave detection, and the invitation list is not authoritative over it.
pub fn invitation_mirror_was_withdrawn(
    mapping: &Mapping,
    peer_pub: &str,
    offered_album_ids: &std::collections::HashSet<String>,
) -> bool {
    mapping.role == Role::Member
        && mapping.via == "invite"
        && mapping.peer == peer_pub
        && mapping
            .remote_album_id
            .as_deref()
            .map(|id| !offered_album_ids.contains(id))
            .unwrap_or(false)
}

/// Reconcile an album's local membership against the people an invitation names.
///
/// `wanted`  — user ids the sender currently names (local ids, echoed back from our own directory)
/// `current` — ids already on the album, owner excluded
/// `local`   — our own human user ids; anything outside this is a utility user
///
/// Two rules carry the safety here:
///  - An EMPTY `wanted` is not "remove everyone". Nobody-named means the invitation is gone, which is
///    a withdrawal and tears the whole mirror down elsewhere. Diffing it instead would let a failed
///    or empty poll silently strip every member of a live album.
///  - Only ids in `local` are ever removed. Utility users own the mirror and its stubs; removing one
///    would strand the content it holds.
pub fn diff_invitees(wanted: &[String], current: &[String], local: &[String]) -> InviteeDiff {
    if wanted.is_empty() {
        return InviteeDiff { add: Vec::new(), remove: Vec::new() };
    }
    let want: std::collections::HashSet<&String> = wanted.iter().collect();
    let have: std::collections::HashSet<&String> = current.iter().collect();
    let mine: std::collections::HashSet<&String> = local.iter().collect();
    InviteeDiff {
        add: local.iter().filter(|id| want.contains(id) && !have.contains(id)).cloned().collect(),
        remove: current.iter().filter(|id| mine.contains(id) && !want.contains(id)).cloned().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Mapping;

    #[test]
    fn adds_and_removes_and_never_touches_non_local_users() {
        // Removal is the half that matters: dropping one person while others remain is a revocation.
        // Without it the sender's action appears to work and silently does nothing.
        let local = vec!["nan".to_string(), "second".to_string()];
        let diff = diff_invitees(
            &["nan".to_string(), "second".to_string()],
            &["nan".to_string()],
            &local,
        );
        assert_eq!(diff, InviteeDiff { add: vec!["second".into()], remove: vec![] });

        let diff = diff_invitees(
            &["second".to_string()],
            &["nan".to_string(), "second".to_string()],
            &local,
        );
        assert_eq!(diff, InviteeDiff { add: vec![], remove: vec!["nan".into()] });

        // a utility user holding the mirror is not in `local` and must never be removed
        let diff = diff_invitees(
            &["nan".to_string()],
            &["nan".to_string(), "bot-owner".to_string()],
            &local,
        );
        assert_eq!(diff, InviteeDiff { add: vec![], remove: vec![] });

        // an invitee we have no local account for is simply skipped
        let diff = diff_invitees(&["ghost".to_string()], &[], &local);
        assert_eq!(diff, InviteeDiff { add: vec![], remove: vec![] });
    }

    #[test]
    fn an_empty_invitee_list_is_never_treated_as_remove_everyone() {
        // "Nobody named" means a withdrawal, handled by tearing the mirror down as a whole. If it were
        // treated as a diff, a failed or empty poll would silently strip every member instead.
        let diff = diff_invitees(&[], &["nan".to_string()], &["nan".to_string()]);
        assert_eq!(diff, InviteeDiff { add: vec![], remove: vec![] });
    }

    fn mapping_fixture() -> Mapping {
        serde_json::from_value(serde_json::json!({
            "id": "m1",
            "role": "member",
            "albumId": "local-album",
            "albumName": "Holidays",
            "peer": "origin",
            "remoteAlbumId": "album-1",
            "permissions": "view",
            "via": "invite",
            "dead": true,
        }))
        .expect("a mapping as it is stored")
    }

    #[test]
    fn a_withdrawn_invitation_mirror_is_retired_even_after_it_was_marked_dead() {
        assert!(invitation_mirror_was_withdrawn(&mapping_fixture(), "origin", &Default::default()));
    }

    #[test]
    fn a_link_mirror_is_not_the_invitation_lists_to_retire() {
        // A link-redeemed mirror has its own membership and lifecycle; the invitation list is not
        // authoritative over it, so it must never be torn down by a poll that omits it.
        let mut mapping = mapping_fixture();
        mapping.via = "link".to_string();
        assert!(!invitation_mirror_was_withdrawn(&mapping, "origin", &Default::default()));
    }
}
