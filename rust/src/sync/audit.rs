/** sync/audit.rs — the trail an album keeps of its own history. See PORT.md. */
use crate::immich::client::Client;
use crate::state::State;

/// Write one line of an album's history, as a comment on the album itself.
///
/// The same channel and the same call the reunion uses, so an album narrates its own history to
/// everyone in it — no separate log for a person to be told about.
///
/// Best effort, and deliberately NOT tagged on failure: the act it describes is already recorded in
/// `state.db`, so a trail line is worth a retry rather than worth failing the act. Leaving the tag
/// unwritten is what makes the next attempt try again.
pub async fn audit_line(
    state: &State,
    client: &Client,
    mapping_id: &str,
    album_id: &str,
    event: &str,
    text: &str,
) -> bool {
    let tag = format!("audit:{event}:{album_id}");
    if state.store.seen_act_has(&tag).unwrap_or(false) {
        return false;
    }
    let Ok(bot) = crate::sync::house_bot::ensure_house_bot(state, client).await else {
        return false;
    };
    let Some(key) = bot.api_key.clone() else { return false };
    let Ok(posted) = crate::sync::comments::post_comment(
        client,
        album_id,
        text,
        &crate::immich::client::Auth::Key(&key),
    )
    .await
    else {
        return false;
    };
    let _ = state.store.seen_act_add(&tag, mapping_id);
    if let Some(id) = posted.get("id").and_then(|v| v.as_str()) {
        // Marked local so the comment loop does not push it back to the peer as something a human
        // said here; it is ours, and it says so.
        let _ = state.store.seen_act_add(&format!("local:{id}"), mapping_id);
    }
    crate::log!("audit on \"{}\": {text}", &album_id[..album_id.len().min(8)]);
    true
}
