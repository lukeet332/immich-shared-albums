/** sync/album_teardown.rs — what leaving a share is allowed to remove. See ARCHITECTURE.md. */
use crate::store::{Mapping, Role};

/// The fields the decision reads.
///
/// `adopted` is a RECORDED fact — the mapping was pointed at an album that already existed — not
/// something inferred from the album's contents, because inferring it would mean deciding whose
/// photos these are at the moment of deletion.
pub struct TeardownMapping<'a> {
    pub role: Role,
    pub adopted: Option<bool>,
    pub album_name: &'a str,
}

impl<'a> From<&'a Mapping> for TeardownMapping<'a> {
    fn from(mapping: &'a Mapping) -> Self {
        TeardownMapping {
            role: mapping.role,
            adopted: mapping.adopted,
            album_name: &mapping.album_name,
        }
    }
}

/// What leaving a share may touch.
pub struct TeardownPlan {
    /// May this sidecar DELETE the local album? The whole question this module answers.
    pub delete_album: bool,
    /// Why, for the log — a teardown that quietly spares an album should say so.
    pub reason: &'static str,
}

/// A mirror this sidecar created is OURS: deleting it is what makes a join fully reversible. An
/// ADOPTED album is not — it existed before the share and holds a person's own photos, so leaving
/// must give up the mapping and nothing else. The stubs of the peer's photos are the peer's to
/// withdraw and are not this decision's concern.
pub fn album_teardown(mapping: TeardownMapping<'_>) -> TeardownPlan {
    // ROLE FIRST, and independently of `adopted` ON PURPOSE: only a mirror this sidecar created is
    // ever ours to delete, so a caller that forgets to record adoption still cannot delete a real
    // album. The two facts answer different questions and must not be folded into one check.
    if mapping.role != Role::Member {
        return TeardownPlan { delete_album: false, reason: "owner mapping — this household's own album" };
    }
    if mapping.adopted == Some(true) {
        return TeardownPlan { delete_album: false, reason: "adopted album belongs to its owner" };
    }
    TeardownPlan { delete_album: true, reason: "mirror created by this sidecar" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(role: Role, adopted: Option<bool>) -> TeardownPlan {
        album_teardown(TeardownMapping { role, adopted, album_name: "Holidays" })
    }

    #[test]
    fn a_mirror_this_sidecar_created_is_ours_to_delete() {
        let p = plan(Role::Member, None);
        assert!(p.delete_album);
        assert_eq!(p.reason, "mirror created by this sidecar");
    }

    #[test]
    fn an_ADOPTED_album_is_never_deleted_it_holds_a_persons_own_photos() {
        // It existed before the share, so leaving gives up the mapping and nothing else.
        let p = plan(Role::Member, Some(true));
        assert!(!p.delete_album);
        assert_eq!(p.reason, "adopted album belongs to its owner");
    }

    #[test]
    fn an_OWNER_mapping_is_never_deleted_however_adoption_reads() {
        // The property that matters: role is checked FIRST and independently, so a caller that
        // forgot to record adoption still cannot delete a real album.
        for adopted in [None, Some(false), Some(true)] {
            let p = plan(Role::Owner, adopted);
            assert!(!p.delete_album, "owner mapping with adopted={adopted:?} must be spared");
            assert_eq!(p.reason, "owner mapping — this household's own album");
        }
    }

    #[test]
    fn an_EXPLICIT_false_adoption_still_deletes_because_it_means_not_adopted() {
        // `Some(false)` is "we recorded that this is NOT an adopted album" — a mirror we made.
        assert!(plan(Role::Member, Some(false)).delete_album);
        // And `None` is "never stated", which for a member mapping is also a mirror we made.
        assert!(plan(Role::Member, None).delete_album);
    }

    #[test]
    fn the_plan_maps_from_a_stored_mapping() {
        let mut mapping = crate::store::Mapping {
            id: "m1".into(),
            role: Role::Member,
            album_id: "a1".into(),
            album_name: "Holidays".into(),
            peer: "peer-a".into(),
            remote_album_id: None,
            remote_mapping_id: None,
            permissions: "contribute".into(),
            host_slug: None,
            via: "link".into(),
            for_peer_user_ids: None,
            album_owner_name: None,
            album_owner_id: None,
            adopted: None,
            reunified: None,
            dead: false,
            dead_at: None,
            dead_reason: None,
            fail_count: None,
            local_version: None,
            remote_version: None,
            comment_count: None,
            remote_comment_count: None,
        };
        assert!(album_teardown(TeardownMapping::from(&mapping)).delete_album);
        mapping.role = Role::Owner;
        assert!(!album_teardown(TeardownMapping::from(&mapping)).delete_album);
        mapping.role = Role::Member;
        mapping.adopted = Some(true);
        assert!(!album_teardown(TeardownMapping::from(&mapping)).delete_album);
    }
}
