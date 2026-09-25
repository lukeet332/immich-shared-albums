/** web/album_member_audit.rs — the album's own record of somebody being taken off it. See PORT.md. */
use axum::http::HeaderMap;

use crate::immich::client::Client;

/// Write what "the owner removed a person" actually MEANS for this album.
///
/// Two different things, and saying the wrong one would be worse than saying nothing:
///
///   * an INVITATION album — the membership our marker holds IS the share, so its removal ends the
///     share: the household's mirror tears itself down and this album is no longer shared with them.
///   * a LINK album — the grant is the link, and nobody was named by it, so removing a person does
///     NOT end the share: anyone still holding the link can walk back in. An owner who thinks they
///     have revoked access here has done nothing of the sort, and the album should say so.
///
/// Fire and forget: the removal has already been answered, and the bot is added on the caller's own
/// credential because on their album that membership is their act.
pub fn post_removal(
    state: std::sync::Arc<crate::state::State>,
    headers: HeaderMap,
    album_id: String,
    removed_user_id: String,
) {
    tokio::spawn(async move {
        let client: &Client = crate::immich::client::shared();
        let Some(creds) = crate::web::auth::caller_creds(&headers) else {
            return;
        };
        let name = crate::immich::client::users_by_id(client, 60_000)
            .await
            .get(&removed_user_id)
            .map(|u| u.name.clone())
            .unwrap_or_else(|| "A person".to_string());
        // Which KIND of share this album is, from OUR mapping: the path only names the album.
        let via = state
            .collections()
            .mappings
            .iter()
            .find(|m| m.album_id == album_id && m.role == crate::store::Role::Owner)
            .map(|m| m.via.clone())
            .unwrap_or_default();
        let text = removal_text(&via, &name);
        if let Err(e) =
            crate::sync::house_bot::add_house_bot_to_album(&state, client, &album_id, &creds).await
        {
            crate::log!("could not put the bot on {album_id} to record a removal: {e}");
            return;
        }
        // One line per person removed, so two removals are two lines: `audit_line` tags by event AND
        // album, and a plain "removed" would suppress every removal after the first.
        crate::sync::audit::audit_line(
            &state,
            client,
            &format!("member:{album_id}"),
            &album_id,
            &format!("member_removed:{removed_user_id}"),
            &text,
        )
        .await;
    });
}

/// What the album says. The LINK case exists because removing a person there revokes nothing, and an
/// owner who believes otherwise has been misled by the silence.
fn removal_text(via: &str, name: &str) -> String {
    if via == "link" {
        format!(
            "{name} was removed from this album. The share LINK is still live, so anyone holding it can join again — delete the link to end the share."
        )
    } else {
        format!(
            "{name} was removed from this album — their invitation is withdrawn, so it is no longer shared with them."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::traffic_triggers::removed_person;

    #[test]
    fn a_removal_says_which_kind_of_share_this_album_is() {
        // An invitation: the marker's membership IS the share, so this really did revoke it.
        let invited = removal_text("invite", "Demo Nan");
        assert!(invited.contains("Demo Nan"), "it names the person: {invited}");
        assert!(invited.contains("no longer shared"), "it claims the revocation: {invited}");

        // A link: it did NOT revoke anything, and the line has to say so rather than imply safety.
        let linked = removal_text("link", "Demo Nan");
        assert!(linked.contains("LINK is still live"), "it warns: {linked}");
        assert!(
            linked.contains("delete the link"),
            "and says what actually ends the share: {linked}"
        );
        assert!(
            !linked.contains("no longer shared"),
            "it must not claim a revocation that did not happen: {linked}"
        );
    }

    #[test]
    fn an_album_with_no_mapping_of_ours_gets_the_invitation_wording() {
        // "invite" describes OUR marker, which is the one thing we can be sure of; the link wording
        // asserts something about a grant we would have no record of.
        assert!(removal_text("", "X").contains("invitation"));
    }

    #[test]
    fn the_removal_shape_comes_from_the_path_alone() {
        // No body and no pre-read: both ids are in the path, so nothing has to be resolved while it
        // still exists (unlike a link delete, whose album is about to be forgotten).
        assert_eq!(
            removed_person("DELETE", "/api/albums/alb/user/person"),
            Some(("alb".to_string(), "person".to_string()))
        );
    }
}
