/** sync/house-bot.rs — this household's own bot account. See ARCHITECTURE.md. */
use crate::config::{bot_prefix, UTILITY_EMAIL_DOMAIN};
use crate::immich::access::Creds;
use crate::immich::client::{Auth, Client};
use crate::immich::contributors::{ensure_utility_user, ContributorSpec};
use crate::state::State;
use crate::store::Contributor;
use serde_json::json;

/// What the bot may do, and nothing else: read an album and its assets, and comment. Deliberately
/// no asset write, no album write, no membership write — it joins albums as a VIEWER, so it can
/// never add, move or remove a photo, and `apiKey.create` is absent so it cannot widen itself. The
/// two profile-image scopes set the bot's OWN picture and reach no library.
pub const HOUSE_BOT_PERMISSIONS: [&str; 7] = [
    "album.read",
    "asset.read",
    "asset.view",
    "activity.create",
    "activity.read",
    "userProfileImage.create",
    "userProfileImage.update",
];

/// The name this account wears wherever a human meets it: an album's People list, and the author
/// line of the audit trail it posts. Named after the addon, because that is what it is — not a
/// person and not a household, so it carries neither a person's name nor the utility suffix.
pub const HOUSE_BOT_DISPLAY_NAME: &str = "immich-shared-albums (bot)";

/// The state key this account is filed under. One place, so a caller naming the bot and the caller
/// provisioning it cannot disagree.
pub fn house_bot_slug() -> String {
    format!("{}bot", bot_prefix::HOUSE)
}

/// The bot, provisioned on first use.
///
/// LAZY on purpose: a household that never reunifies anything and never generates an audit line has
/// no extra account sitting in its member list. Creating it eagerly would make every install one
/// account larger for a feature it may never use.
pub async fn ensure_house_bot(state: &State, client: &Client) -> Result<Contributor, String> {
    let slug = house_bot_slug();
    ensure_utility_user(
        state,
        client,
        &ContributorSpec {
            display_name: HOUSE_BOT_DISPLAY_NAME.to_string(),
            // Verbatim: the suffix exists to say "this stands in for a person", and this is not one.
            full_name: Some(HOUSE_BOT_DISPLAY_NAME.to_string()),
            state_key: slug.clone(),
            email: format!("{slug}@{UTILITY_EMAIL_DOMAIN}"),
            via_peer: None,
            peer_user_id: None,
            home_peer: None,
            permissions: Some(
                HOUSE_BOT_PERMISSIONS
                    .iter()
                    .map(|p| p.to_string())
                    .collect(),
            ),
        },
    )
    .await
}

/// Add the bot to an album as a VIEWER, using the album owner's own credentials.
///
/// The owner's credentials, because the membership has to be their action — and it has to be a
/// membership at all, because `GET /albums` is scoped per credential: the household admin key cannot
/// read an album a different person owns (it answers 400, and the album is simply absent from its
/// list). A viewer is the least it can be while still being able to read the photos.
///
/// Idempotent: Immich answers 200 for someone who is already a member, silently ignoring it, so this
/// checks the membership list rather than trusting a status code.
pub async fn add_house_bot_to_album(
    state: &State,
    client: &Client,
    album_id: &str,
    owner_creds: &Creds,
) -> Result<(), String> {
    add_house_bot_to_album_as(state, client, album_id, &Auth::Creds(owner_creds)).await
}

/// The credential-taking form, for paths with no human in the room: the sidecar writing into an
/// album of its OWN household, where the admin key already reaches.
pub async fn add_house_bot_to_album_as(
    state: &State,
    client: &Client,
    album_id: &str,
    auth: &Auth<'_>,
) -> Result<(), String> {
    let bot = ensure_house_bot(state, client).await?;
    // Empty = not provisioned yet; there is no account to add.
    let bot_id = bot.user_id.clone();
    if bot_id.is_empty() {
        return Err("the house bot has no user id after provisioning".to_string());
    }
    let album = client
        .get_album(album_id, auth)
        .await
        .map_err(|e| e.message())?
        .unwrap_or(serde_json::Value::Null);
    let already = album
        .get("albumUsers")
        .and_then(|u| u.as_array())
        .map(|users| {
            users
                .iter()
                .any(|au| au.pointer("/user/id").and_then(|v| v.as_str()) == Some(&bot_id))
        })
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    client
        .json(
            reqwest::Method::PUT,
            &format!("/albums/{album_id}/users"),
            auth,
            Some(&json!({ "albumUsers": [{ "userId": bot_id, "role": "viewer" }] })),
        )
        .await
        .map_err(|e| e.message())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bot_may_read_and_comment_and_nothing_else() {
        // The list is the account's entire authority. Adding a write scope here would let the bot
        // change a library it is only supposed to read, so each absence is deliberate.
        for forbidden in [
            "asset.write",
            "asset.delete",
            "album.write",
            "albumAsset.create",
            "apiKey.create",
        ] {
            assert!(
                !HOUSE_BOT_PERMISSIONS.contains(&forbidden),
                "{forbidden} must not be granted"
            );
        }
        assert!(HOUSE_BOT_PERMISSIONS.contains(&"album.read"));
        assert!(
            HOUSE_BOT_PERMISSIONS.contains(&"activity.create"),
            "it has to be able to comment"
        );
    }

    #[test]
    fn the_bot_is_named_after_the_addon_not_after_a_person() {
        // No utility suffix: that suffix says "this stands in for a person", and this is not one.
        assert!(!HOUSE_BOT_DISPLAY_NAME.ends_with(crate::config::UTILITY_SUFFIX));
        assert!(
            HOUSE_BOT_DISPLAY_NAME.contains("bot"),
            "a human must be able to tell what it is"
        );
    }

    #[test]
    fn the_slug_is_the_house_namespace_and_cannot_collide_with_a_person() {
        let slug = house_bot_slug();
        assert!(slug.starts_with(bot_prefix::HOUSE));
        assert!(
            !slug.starts_with(bot_prefix::PERSON),
            "namespaces stay disjoint"
        );
    }
}
