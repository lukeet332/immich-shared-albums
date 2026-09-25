/** web/album_member_audit.rs — the album's own record of somebody being taken off it. See PORT.md. */
use axum::http::HeaderMap;

use crate::immich::client::Client;

/// Record that the owner took a person off their album.
///
/// One short sentence, like every other line of ours. The kind of share it was does NOT change the
/// sentence: an invitation's removal really does revoke, a link's does not, and saying so in the
/// album every time was an explanation nobody asked to read. That distinction lives in the docs
/// (`p2p/wire-protocol.md`, "bearer grant") and in the line a withdrawn link posts for itself.
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
            &removal_text(&name),
        )
        .await;
    });
}

/// What the album says. Short by design — see `post_removal`.
fn removal_text(name: &str) -> String {
    format!("{name} was removed from this album.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::traffic_triggers::removed_person;

    #[test]
    fn a_removal_is_one_short_sentence_naming_the_person() {
        // The formula every line of ours uses now: who, what happened, full stop. The kind of share
        // it was does NOT change the sentence — that reasoning lives in the docs, not in somebody's
        // album, where it was an explanation nobody asked to read.
        assert_eq!(
            removal_text("Demo Nan (via Demo household (B) server)"),
            "Demo Nan (via Demo household (B) server) was removed from this album."
        );
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
