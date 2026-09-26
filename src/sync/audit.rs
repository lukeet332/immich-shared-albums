/** sync/audit.rs — the trail an album keeps of its own history. See ARCHITECTURE.md. */
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
    let Some(key) = bot.api_key.clone() else {
        return false;
    };
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
        // And tagged as an AUDIT line, which is what lets a reader hide these: the tag is exact where
        // a text marker would not be, because a RELAYED human comment can also be posted by our bot
        // (the relay falls back to it when the author has no stand-in key here).
        let _ = state
            .store
            .seen_act_add(&format!("{AUDIT_ACTIVITY_TAG}{id}"), mapping_id);
    }
    crate::log!(
        "audit on \"{}\": {text}",
        crate::sync::peer_mapping_id::short_id(album_id)
    );
    true
}

/// Prefix of the `seen_activity` tag that marks one Immich activity as ours-to-hide. Read by
/// `web/activity_filter.rs`.
pub const AUDIT_ACTIVITY_TAG: &str = "audit-activity:";

/// Is this Immich activity id one of our audit lines? The lookup the per-person filter runs per row.
pub fn is_audit_activity(state: &State, activity_id: &str) -> bool {
    state
        .store
        .seen_act_has(&format!("{AUDIT_ACTIVITY_TAG}{activity_id}"))
        .unwrap_or(false)
}
