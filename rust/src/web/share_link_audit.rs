/** web/share_link_audit.rs — the album's own record of a share link being withdrawn. See PORT.md. */
use axum::http::HeaderMap;
use serde_json::Value;

use crate::immich::client::{Auth, Client};

/// Resolve which album a share-link delete is about, BEFORE the link is gone.
///
/// Runs as the CALLER: deleting a link is their act, and their credential is the only thing that can
/// both read the link and later put our bot on their album to record it (the household admin key
/// cannot touch an album it does not own). Returns `None` for any other request, so this costs
/// nothing on the traffic that cannot matter.
pub async fn album_of_deleted_link(
    method: &str,
    path: &str,
    headers: &HeaderMap,
) -> Option<String> {
    let link_id = crate::sync::traffic_triggers::deleted_share_link_id(method, path)?;
    let creds = crate::web::auth::caller_creds(headers)?;
    let links = crate::immich::client::shared()
        .get("/shared-links", &Auth::Creds(&creds))
        .await
        .ok()
        .flatten()?;
    links
        .as_array()?
        .iter()
        .find(|l| l.get("id").and_then(|v| v.as_str()) == Some(link_id.as_str()))
        .and_then(|l| l.pointer("/album/id").and_then(|v| v.as_str()))
        .map(str::to_string)
}

/// Record it on the album, as the person who did it.
///
/// Fire-and-forget: the delete has already been answered, and a trail line must never make someone
/// wait for their own click. The bot is added on the caller's own credential for the same reason the
/// reunion does it that way — the membership is their act, and without it the bot cannot comment on
/// their album at all.
pub fn post_withdrawal(state: std::sync::Arc<crate::state::State>, headers: HeaderMap, album_id: String) {
    tokio::spawn(async move {
        let client: &Client = crate::immich::client::shared();
        let Some(creds) = crate::web::auth::caller_creds(&headers) else {
            return;
        };
        if let Err(e) =
            crate::sync::house_bot::add_house_bot_to_album(&state, client, &album_id, &creds).await
        {
            // Best effort, and deliberately quiet at the call site: on an album the caller can read
            // but not re-share, this is where the trail stops.
            crate::log!("could not put the bot on {album_id} to record a withdrawn link: {e}");
            return;
        }
        crate::sync::audit::audit_line(
            &state,
            client,
            &format!("link:{album_id}"),
            &album_id,
            "link_withdrawn",
            "Share link deleted — households that joined through it no longer see this album, and the photos they added come back out with them.",
        )
        .await;
    });
}

/// Turn one `GET /api/shared-links` answer into the ids of links that no longer exist.
///
/// Used by the sweep's own check in tests and kept here so the two readers of a link list agree on
/// what "the album is still shared" means.
pub fn link_ids_for_album(links: &[Value], album_id: &str) -> Vec<String> {
    links
        .iter()
        .filter(|l| l.pointer("/album/id").and_then(|v| v.as_str()) == Some(album_id))
        .filter_map(|l| l.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::traffic_triggers::deleted_share_link_id;
    use serde_json::json;

    #[test]
    fn only_a_single_link_delete_is_a_withdrawal() {
        assert_eq!(
            deleted_share_link_id("DELETE", "/api/shared-links/abc-123").as_deref(),
            Some("abc-123")
        );
        // The collection route is not a delete of a link we can name, and a nested path is not a
        // link id: both must fall through rather than resolve to something arbitrary.
        assert_eq!(deleted_share_link_id("DELETE", "/api/shared-links"), None);
        assert_eq!(deleted_share_link_id("DELETE", "/api/shared-links/abc/extra"), None);
        assert_eq!(deleted_share_link_id("DELETE", "/api/shared-links/"), None);
        // And nothing but a delete.
        assert_eq!(deleted_share_link_id("GET", "/api/shared-links/abc"), None);
        assert_eq!(deleted_share_link_id("POST", "/api/shared-links/abc"), None);
    }

    #[test]
    fn the_album_is_found_by_the_link_it_was_deleted_from() {
        let links = vec![
            json!({ "id": "one", "album": { "id": "album-a" } }),
            json!({ "id": "two", "album": { "id": "album-b" } }),
            json!({ "id": "three", "album": {} }),
        ];
        assert_eq!(link_ids_for_album(&links, "album-a"), vec!["one".to_string()]);
        assert!(link_ids_for_album(&links, "album-b").contains(&"two".to_string()));
        assert!(link_ids_for_album(&links, "album-missing").is_empty());
        // A row with no album id is nobody's grant: it must not match every album in the loop.
        assert!(!link_ids_for_album(&links, "").contains(&"three".to_string()));
    }
}
