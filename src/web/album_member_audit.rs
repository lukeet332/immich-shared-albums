/** web/album_member_audit.rs — the album's own record of a removal, and the ONE fire-and-forget trail writer both audit files share. See ARCHITECTURE.md. */
use axum::http::HeaderMap;

use crate::immich::client::Client;

/// Record that the owner took a person off their album.
///
/// One short sentence, like every other line of ours. The kind of share it was does NOT change the
/// sentence: an invitation's removal really does revoke, a link's does not, and saying so in the
/// album every time was an explanation nobody asked to read. That distinction lives in the docs
/// (`p2p/wire-protocol.md`, "bearer grant") and in the line a withdrawn link posts for itself.
///
/// Fire and forget: the removal has already been answered.
pub fn post_removal(
    state: std::sync::Arc<crate::state::State>,
    headers: HeaderMap,
    album_id: String,
    removed_user_id: String,
) {
    // One line per person removed, so two removals are two lines: `audit_line` tags by event AND
    // album, and a plain "removed" would suppress every removal after the first.
    let mapping_id = format!("member:{album_id}");
    let event = format!("member_removed:{removed_user_id}");
    record_on_album(
        state,
        headers,
        album_id,
        "a removal",
        mapping_id,
        event,
        |client| async move { removal_text(&removed_person_name(client, &removed_user_id).await) },
    );
}

/// The person's name as Immich has it now, or the fallback the line keeps when Immich cannot say.
async fn removed_person_name(client: &Client, user_id: &str) -> String {
    crate::immich::client::users_by_id(client, 60_000)
        .await
        .get(user_id)
        .map(|u| u.name.clone())
        .unwrap_or_else(|| "A person".to_string())
}

/// The one fire-and-forget writer both trails go through — `post_removal` here and
/// `share_link_audit::post_withdrawal`: spawn, resolve the CALLER's credential, build the line,
/// add the house bot to the album on that credential, then post one audit line. The bot-add stays
/// BEFORE the line, because without the membership the bot cannot comment on the album at all —
/// and the caller's credential is the right one, because on their album the membership is their
/// act (the household admin key cannot reach an album a different person owns).
///
/// `why` is only the noun of the bot-add failure log. A failed add ends the trail quietly: on an
/// album the caller can read but not re-share, that is where the trail stops.
pub(crate) fn record_on_album<M, F>(
    state: std::sync::Arc<crate::state::State>,
    headers: HeaderMap,
    album_id: String,
    why: &'static str,
    mapping_id: String,
    event: String,
    line: M,
) where
    M: FnOnce(&'static Client) -> F + Send + 'static,
    F: std::future::Future<Output = String> + Send,
{
    tokio::spawn(async move {
        let client: &'static Client = crate::immich::client::shared();
        let Some(creds) = crate::web::auth::caller_creds(&headers) else {
            return;
        };
        let line = line(client).await;
        if let Err(e) =
            crate::sync::house_bot::add_house_bot_to_album(&state, client, &album_id, &creds).await
        {
            crate::log!("could not put the bot on {album_id} to record {why}: {e}");
            return;
        }
        crate::sync::audit::audit_line(&state, client, &mapping_id, &album_id, &event, &line).await;
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
