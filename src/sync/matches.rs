/** sync/matches.rs — pairing two households' albums by hand. See ARCHITECTURE.md. */
use crate::store::{Mapping, OwnedAlbum, Role};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// An album name as two servers can agree on it: trimmed, inner whitespace collapsed, lowercased.
/// The pairing rule is name-based, so the comparison has to survive the ways two people type the
/// same album — and it must NOT be cleverer than that, because a fuzzy match would propose merging
/// albums that are not the same.
pub fn normalise_album_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Two records describe the same span of time.
///
/// A MISSING date answers false rather than true: dates that are unknown must sort last, not match
/// on nothing. (`startDate` alone is used as the end when there is no end, so a one-day album is a
/// one-day span rather than an empty one.)
pub fn dates_overlap(mine: &OwnedAlbum, theirs: &OwnedAlbum) -> bool {
    let mine_from = mine.start_date.clone().unwrap_or_default();
    let mine_to = mine
        .end_date
        .clone()
        .or_else(|| mine.start_date.clone())
        .unwrap_or_default();
    let theirs_from = theirs.start_date.clone().unwrap_or_default();
    let theirs_to = theirs
        .end_date
        .clone()
        .or_else(|| theirs.start_date.clone())
        .unwrap_or_default();
    if mine_from.is_empty() || theirs_from.is_empty() {
        return false;
    }
    mine_from <= theirs_to && theirs_from <= mine_to
}

/// The facts one row is made of: what a person reads, and what the server acts on. Two candidates
/// agreeing on all of them ARE the same row — the panel would print them identically — and the same
/// action, because both are resolved by NAME: the album picks the source, the mapping picks the
/// share. Keeping one hides nothing and keeps the list readable.
fn as_one_row(candidate: &AlbumCandidate) -> String {
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{}",
        candidate.mine.name,
        candidate.theirs.name,
        candidate.theirs.owner_user_id.as_deref().unwrap_or(""),
        candidate.theirs.owner_name
    )
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCandidate {
    pub mine: OwnedAlbum,
    pub theirs: OwnedAlbum,
    /// The same name AND overlapping dates — what the panel shows first, because it is the stronger
    /// signal of two halves of one album.
    pub same_dates: bool,
    /// Why this pair was proposed, in the words the panel prints.
    pub why: String,
}

/// One row of the ledger a mapping keeps, as adoption seeds it.
#[derive(Clone, Debug, PartialEq)]
pub struct SeedRow {
    pub checksum: String,
    pub local_asset: String,
}

/// The `(checksum, localAsset)` pairs an album's assets make, ONE row per checksum.
///
/// The ledger is unique on `(mapping, checksum)`, so a duplicate would abort a seed half-written.
/// An asset with no checksum or no id is SKIPPED rather than guessed at — there is nothing to key it
/// on, and a guess here either offers a photo twice or suppresses one that was never sent.
pub fn seed_rows_for(assets: &[Value]) -> Vec<SeedRow> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for asset in assets {
        // BOTH must be present AND non-empty. The TypeScript skips on `!checksum || !asset.id`, and
        // an empty string is falsy there — so `""` is not an id, and accepting it here would key a
        // ledger row on nothing.
        let (Some(checksum), Some(id)) = (
            asset
                .get("checksum")
                .and_then(|v| v.as_str())
                .filter(|c| !c.is_empty()),
            asset
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|i| !i.is_empty()),
        ) else {
            continue;
        };
        if seen.insert(checksum.to_string()) {
            rows.push(SeedRow {
                checksum: checksum.to_string(),
                local_asset: id.to_string(),
            });
        }
    }
    rows
}

/// The rows an adoption must seed: the photos the peer ALREADY holds, and only those.
///
/// Seeding a row means "the peer has this, do not offer it". Reunification exists to give each side
/// the UNION, so the photos only THIS side holds must stay unseeded — offering them to the peer is
/// what makes the merge reach both sides. And a peer that could not be asked (no manifest) seeds
/// NOTHING, deliberately: offering a duplicate materialises a stub beside the peer's own original,
/// which nothing repairs on its own, while the other direction is repaired by a later reunion.
pub fn seed_rows_for_adoption(
    assets: &[Value],
    peer_holds: Option<&std::collections::HashSet<String>>,
) -> Vec<SeedRow> {
    let rows = seed_rows_for(assets);
    match peer_holds {
        Some(held) => rows
            .into_iter()
            .filter(|r| held.contains(&r.checksum))
            .collect(),
        // `None` is "nobody could be asked" — NOT "they hold nothing". Both seed nothing, but the
        // caller logs them differently, so the distinction is kept in the signature.
        None => Vec::new(),
    }
}

/// Albums on two servers that look like two halves of one album.
///
/// Name equality is the gate; an album owned by the SAME person on both sides is skipped, because
/// that is one library seen twice rather than two halves — a shared album restored on each server is
/// owned by a different person on each.
pub fn match_albums(mine: &[OwnedAlbum], theirs: &[OwnedAlbum]) -> Vec<AlbumCandidate> {
    let mut by_name: std::collections::HashMap<String, Vec<OwnedAlbum>> =
        std::collections::HashMap::new();
    for album in theirs {
        by_name
            .entry(normalise_album_name(&album.name))
            .or_default()
            .push(album.clone());
    }
    let mut candidates: Vec<AlbumCandidate> = Vec::new();
    let mut shown: std::collections::HashSet<String> = std::collections::HashSet::new();
    for album in mine {
        let Some(bucket) = by_name.get(&normalise_album_name(&album.name)) else {
            continue;
        };
        for peer_album in bucket {
            if peer_album.owner_user_id.is_some() && peer_album.owner_user_id == album.owner_user_id
            {
                continue;
            }
            let same_dates = dates_overlap(album, peer_album);
            let candidate = AlbumCandidate {
                mine: album.clone(),
                theirs: peer_album.clone(),
                same_dates,
                why: if same_dates {
                    "same album name, overlapping dates".to_string()
                } else {
                    "same album name".to_string()
                },
            };
            let row = as_one_row(&candidate);
            if !shown.insert(row) {
                continue;
            }
            candidates.push(candidate);
        }
    }
    // Overlapping dates first — the stronger signal — then the bigger album, so the most likely
    // pairing is the one a person reads first.
    candidates.sort_by(|x, y| {
        y.same_dates
            .cmp(&x.same_dates)
            .then(y.theirs.asset_count.cmp(&x.theirs.asset_count))
    });
    candidates
}

/// One pairing as the panel needs it: the candidate, plus WHOSE server the other half is on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMatch {
    #[serde(flatten)]
    pub candidate: AlbumCandidate,
    pub peer: String,
    pub peer_name: String,
}

pub fn matches_with_peer(
    mine: &[OwnedAlbum],
    theirs: &[OwnedAlbum],
    peer_pub: &str,
    peer_name: &str,
) -> Vec<PeerMatch> {
    match_albums(mine, theirs)
        .into_iter()
        .map(|candidate| PeerMatch {
            candidate,
            peer: peer_pub.to_string(),
            peer_name: peer_name.to_string(),
        })
        .collect()
}

/// The share a pairing is about, as the panel has it: enough to say what a person may do next.
pub struct ShareForReunion<'a> {
    pub id: &'a str,
    pub role: Role,
    pub adopted: bool,
    pub reunified: bool,
    pub dead: bool,
}

/// What a person can do about one candidate.
///
/// Four cases rather than two, because a share has a DIRECTION and only the one they RECEIVED is
/// theirs to accept: `accept` is the mirror they were given, `waiting` is the one they gave away —
/// where adopting their own album is not an adoption at all, since the album asked for is already
/// the one the share points at. `reunited` is not a button at all: that pairing belongs to the
/// reunified list, and leaving it here would offer a reunion that has already happened.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReunionStep {
    /// No share yet, or the share ended: invite again.
    Invite,
    /// A mirror they were given, which they may adopt their own album into.
    Accept {
        #[serde(rename = "mappingId")]
        mapping_id: String,
    },
    /// The share they gave away. Nothing to do but wait for the other side.
    Waiting,
    /// Already done — listed elsewhere, not offered again.
    Reunited,
}

pub fn reunion_step_for(share: Option<&ShareForReunion<'_>>) -> ReunionStep {
    let Some(share) = share else {
        return ReunionStep::Invite;
    };
    if share.dead {
        return ReunionStep::Invite;
    }
    if share.reunified || share.adopted {
        return ReunionStep::Reunited;
    }
    if share.role == Role::Member {
        ReunionStep::Accept {
            mapping_id: share.id.to_string(),
        }
    } else {
        ReunionStep::Waiting
    }
}

/// The live share for `album_name` on `peer`, if this household already has one.
pub fn share_for<'a>(
    mappings: &'a [Mapping],
    peer_pub: &str,
    album_name: &str,
    owner_user_id: Option<&str>,
) -> Option<ShareForReunion<'a>> {
    let wanted = normalise_album_name(album_name);
    mappings
        .iter()
        .find(|m| {
            // The share this pairing is about is the one FOR that person. A peer can publish
            // same-named albums for several owners, and binding on the name alone would attach the row
            // to someone else's share — an action on a pairing the person was never shown.
            let for_that_person = m.role == Role::Member
                || owner_user_id
                    .map(|owner| {
                        m.for_peer_user_ids
                            .as_ref()
                            .map(|ids| ids.iter().any(|id| id == owner))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
            m.peer == peer_pub
                && !m.dead
                && normalise_album_name(&m.album_name) == wanted
                && for_that_person
        })
        .map(|m| ShareForReunion {
            id: &m.id,
            role: m.role,
            adopted: m.adopted == Some(true),
            reunified: m.reunified == Some(true),
            dead: m.dead,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn album(name: &str, owner: &str, start: Option<&str>, end: Option<&str>) -> OwnedAlbum {
        OwnedAlbum {
            name: name.into(),
            asset_count: 5,
            start_date: start.map(str::to_string),
            end_date: end.map(str::to_string),
            owner_name: owner.into(),
            owner_user_id: Some(owner.into()),
        }
    }

    #[test]
    fn names_pair_across_the_ways_two_people_type_them() {
        assert_eq!(normalise_album_name("  Summer   Trip "), "summer trip");
        assert_eq!(normalise_album_name("SUMMER TRIP"), "summer trip");
        // But NOT fuzzily: two different albums must not be proposed as halves of one.
        assert_ne!(
            normalise_album_name("Summer Trip"),
            normalise_album_name("Summer Trip 2")
        );
    }

    #[test]
    fn a_missing_date_never_matches_on_nothing() {
        assert!(!dates_overlap(
            &album("a", "me", None, None),
            &album("b", "you", None, None)
        ));
        assert!(!dates_overlap(
            &album("a", "me", Some("2026-01-01"), None),
            &album("b", "you", None, None)
        ));
        // A one-day album is a one-day SPAN, not an empty one.
        assert!(dates_overlap(
            &album("a", "me", Some("2026-01-01"), None),
            &album("b", "you", Some("2026-01-01"), Some("2026-01-02"))
        ));
        assert!(!dates_overlap(
            &album("a", "me", Some("2026-01-01"), Some("2026-01-02")),
            &album("b", "you", Some("2026-06-01"), Some("2026-06-02"))
        ));
    }

    #[test]
    fn the_same_owner_on_both_sides_is_one_library_not_two_halves() {
        let mine = vec![album(
            "Holidays",
            "alice",
            Some("2026-01-01"),
            Some("2026-01-02"),
        )];
        let theirs = vec![album(
            "Holidays",
            "alice",
            Some("2026-01-01"),
            Some("2026-01-02"),
        )];
        assert!(
            match_albums(&mine, &theirs).is_empty(),
            "same person, same library"
        );

        let theirs_other = vec![album(
            "Holidays",
            "bob",
            Some("2026-01-01"),
            Some("2026-01-02"),
        )];
        assert_eq!(
            match_albums(&mine, &theirs_other).len(),
            1,
            "two people, two halves"
        );
    }

    #[test]
    fn overlapping_dates_sort_first_because_they_are_the_stronger_signal() {
        let mine = vec![album("Trip", "me", Some("2026-01-01"), Some("2026-01-05"))];
        let theirs = vec![
            album("Trip", "far", Some("2026-09-01"), Some("2026-09-05")),
            album("Trip", "near", Some("2026-01-02"), Some("2026-01-04")),
        ];
        let matched = match_albums(&mine, &theirs);
        assert_eq!(matched.len(), 2);
        assert!(matched[0].same_dates, "the overlapping one leads");
        assert_eq!(matched[0].theirs.owner_user_id.as_deref(), Some("near"));
    }

    #[test]
    fn seeding_keeps_one_row_per_checksum_and_skips_what_it_cannot_key() {
        let assets = vec![
            json!({ "id": "a1", "checksum": "c1" }),
            json!({ "id": "a2", "checksum": "c1" }), // same photo twice in one album
            json!({ "id": "a3" }),                   // nothing to key on
            json!({ "id": "", "checksum": "c4" }),   // an empty id is not an id
        ];
        let rows = seed_rows_for(&assets);
        assert_eq!(
            rows.len(),
            1,
            "one row per checksum, and only what can be keyed"
        );
        assert_eq!(rows[0].local_asset, "a1");
    }

    #[test]
    fn adoption_seeds_only_what_the_peer_already_holds() {
        let assets = vec![
            json!({ "id": "a1", "checksum": "theirs" }),
            json!({ "id": "a2", "checksum": "mine" }),
        ];
        let held: std::collections::HashSet<String> = ["theirs".to_string()].into_iter().collect();
        let seeded = seed_rows_for_adoption(&assets, Some(&held));
        assert_eq!(seeded.len(), 1);
        assert_eq!(
            seeded[0].checksum, "theirs",
            "only theirs — ours must be OFFERED, that is the merge"
        );
    }

    #[test]
    fn a_peer_that_could_not_be_asked_seeds_nothing() {
        // Fails CLOSED: offering a duplicate materialises a stub beside the peer's original, which
        // nothing repairs on its own; the other direction is repaired by a later reunion.
        let assets = vec![json!({ "id": "a1", "checksum": "c1" })];
        assert!(seed_rows_for_adoption(&assets, None).is_empty());
    }

    #[test]
    fn a_share_has_a_direction_and_only_the_received_one_is_acceptable() {
        let member = ShareForReunion {
            id: "m1",
            role: Role::Member,
            adopted: false,
            reunified: false,
            dead: false,
        };
        assert_eq!(
            reunion_step_for(Some(&member)),
            ReunionStep::Accept {
                mapping_id: "m1".into()
            }
        );
        let owner = ShareForReunion {
            id: "m2",
            role: Role::Owner,
            adopted: false,
            reunified: false,
            dead: false,
        };
        assert_eq!(
            reunion_step_for(Some(&owner)),
            ReunionStep::Waiting,
            "the one they gave away"
        );
    }

    #[test]
    fn a_reunion_already_done_is_not_offered_again() {
        // Leaving it in the list offered a reunion that had already happened.
        let adopted = ShareForReunion {
            id: "m1",
            role: Role::Member,
            adopted: true,
            reunified: false,
            dead: false,
        };
        assert_eq!(reunion_step_for(Some(&adopted)), ReunionStep::Reunited);
        let reunified = ShareForReunion {
            id: "m1",
            role: Role::Owner,
            adopted: false,
            reunified: true,
            dead: false,
        };
        assert_eq!(reunion_step_for(Some(&reunified)), ReunionStep::Reunited);
    }

    #[test]
    fn an_ended_share_is_no_share_so_invite_again() {
        let dead = ShareForReunion {
            id: "m1",
            role: Role::Member,
            adopted: false,
            reunified: false,
            dead: true,
        };
        assert_eq!(reunion_step_for(Some(&dead)), ReunionStep::Invite);
        assert_eq!(reunion_step_for(None), ReunionStep::Invite);
    }
}
