//! immich/stand_in_picture.rs — whose face an account of ours wears. See ARCHITECTURE.md.

/// What to do about the profile picture on one of our own utility accounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PicturePlan {
    Leave,
    Wear,
}

/// The picture an account of ours should be given.
///
/// A person on a linked server gets one account here that does two jobs — it owns their mirrored
/// photos, and it is what a human picks in Immich's album picker to share with them. Both jobs put it
/// in front of a person: an album's member list, and the picker. The addon's own picture belongs on
/// the account that IS the addon; on a stand-in for a person it reads as "shared with a bot" when the
/// album is shared with your mother. Their own avatar, when they have one, arrives from their server
/// through `sync_avatar` — and when they have none, Immich's own initial is the honest picture.
pub fn picture_plan_for(represents_person: bool, has_picture: bool) -> PicturePlan {
    if represents_person {
        return PicturePlan::Leave;
    }
    if has_picture {
        PicturePlan::Leave
    } else {
        PicturePlan::Wear
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stand_in_for_a_person_never_wears_the_addons_face() {
        // The unsafe direction: a real person's account wearing a robot reads as "shared with a bot"
        // in an album's People list, and the person it stands in for cannot change it here.
        assert_eq!(picture_plan_for(true, false), PicturePlan::Leave);
        assert_eq!(picture_plan_for(true, true), PicturePlan::Leave);
    }

    #[test]
    fn our_own_accounts_wear_it_once_and_then_leave_it_alone() {
        assert_eq!(picture_plan_for(false, false), PicturePlan::Wear);
        assert_eq!(picture_plan_for(false, true), PicturePlan::Leave);
    }
}
