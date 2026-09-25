/** web/activity_filter.rs — hiding our own audit lines from ONE reader, in the answer they were served. See PORT.md. */
use serde_json::Value;

use crate::sync::audit::is_audit_activity;

/// Whether this caller has asked to SEE the addon's own trail in album comments.
///
/// Default is SHOW: a trail nobody sees is not a trail, and the interesting failure of a visibility
/// preference is hiding the record by accident. The row is per CALLER, so one person's choice cannot
/// change what another person sees.
pub fn audit_visible_for(state: &crate::state::State, caller_id: &str) -> bool {
    state
        .store
        .kv(&visibility_key(caller_id))
        .ok()
        .flatten()
        .and_then(|v| v.get("visible").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

/// Record it. Written as a whole row, like every other settings-shaped row here.
pub fn set_audit_visible(
    state: &crate::state::State,
    caller_id: &str,
    visible: bool,
) -> Result<(), crate::store::StoreError> {
    state.store.kv_set(
        &visibility_key(caller_id),
        &serde_json::json!({ "visible": visible }),
    )
}

/// Namespaced by the caller's id on THIS server — the same id a session resolves to, so one person
/// is one row however they sign in.
fn visibility_key(caller_id: &str) -> String {
    format!("auditVisibleFor:{caller_id}")
}

/// Drop the audit lines from an `activities` answer.
///
/// Immich's comment history reaches the browser as `GET /api/activities`, which our passthrough
/// serves — so this is the one place a per-person preference can be honoured without touching
/// Immich: the rows stay in the database, stay in the album for everyone else, and stay in the trail.
///
/// Two things this must NOT do, both of them easy to get wrong:
///   * drop a row that is not ours. The relay posts another household's HUMAN comment as that
///     person's stand-in, and falls back to our bot when the author has no stand-in key here — so
///     "authored by a bot" is not the test. The tag written when the line was posted is.
///   * reorder what is left. The UI renders this array in order; a filter that rebuilt it would
///     scramble a conversation.
pub fn without_audit_lines(state: &crate::state::State, rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|row| {
            let id = row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            id.is_empty() || !is_audit_activity(state, id)
        })
        .cloned()
        .collect()
}

/// The whole decision for one proxied answer: `None` means "serve it untouched".
///
/// Kept separate from the HTTP plumbing so the rule is testable without a request, and so the
/// passthrough stays a proxy rather than growing a second responsibility.
pub fn filter_activities_body(
    state: &crate::state::State,
    caller_id: &str,
    body: &[u8],
) -> Option<Vec<u8>> {
    if audit_visible_for(state, caller_id) {
        return None;
    }
    let parsed: Value = serde_json::from_slice(body).ok()?;
    let rows = parsed.as_array()?;
    // An answer with no audit lines in it is passed through byte for byte: re-serialising it would
    // change nothing a reader can see, and would risk changing something they can.
    let kept = without_audit_lines(state, rows);
    if kept.len() == rows.len() {
        return None;
    }
    serde_json::to_vec(&Value::Array(kept)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;

    fn state() -> crate::state::State {
        crate::state::State::for_test(Store::open_in_memory().expect("in-memory store"))
    }

    fn tag_as_audit(state: &crate::state::State, id: &str) {
        state
            .store
            .seen_act_add(&format!("{}{id}", crate::sync::audit::AUDIT_ACTIVITY_TAG), "m1")
            .unwrap();
    }

    #[test]
    fn a_reader_keeps_the_trail_unless_they_asked_otherwise() {
        // The default is the whole point: nothing is hidden until somebody says so, and the setting
        // is per CALLER, so one person's choice cannot change what another person sees.
        let s = state();
        let rows = vec![json!({ "id": "a1", "comment": "hello" })];
        tag_as_audit(&s, "a1");
        assert!(audit_visible_for(&s, "user-1"));
        assert!(filter_activities_body(&s, "user-1", serde_json::to_vec(&rows).unwrap().as_slice()).is_none());
    }

    #[test]
    fn hiding_drops_only_our_lines_and_keeps_the_conversation_in_order() {
        let s = state();
        let rows = vec![
            json!({ "id": "human-1", "comment": "Testing" }),
            json!({ "id": "audit-1", "comment": "Reunited with X" }),
            json!({ "id": "human-2", "comment": "Responding" }),
            json!({ "id": "audit-2", "comment": "Invited Y" }),
        ];
        tag_as_audit(&s, "audit-1");
        tag_as_audit(&s, "audit-2");
        let kept = without_audit_lines(&s, &rows);
        assert_eq!(
            kept.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(),
            vec!["human-1", "human-2"],
            "the human comments survive, in the order they arrived"
        );
    }

    #[test]
    fn a_relayed_human_comment_is_never_dropped() {
        // The trap: the relay posts another household's comment AS OUR BOT when the author has no
        // stand-in key, so anything filtering on the author would hide a real person's words.
        let s = state();
        let rows = vec![json!({
            "id": "relayed-1",
            "comment": "from the other household",
            "user": { "name": "immich-shared-albums (bot)" }
        })];
        assert_eq!(without_audit_lines(&s, &rows).len(), 1);
    }

    #[test]
    fn a_row_with_no_id_is_kept() {
        // Immich's own rows are not a contract we get to assume; a row this code cannot identify
        // must be shown rather than dropped.
        let s = state();
        let rows = vec![json!({ "comment": "no id at all" })];
        assert_eq!(without_audit_lines(&s, &rows).len(), 1);
    }

    #[test]
    fn a_non_array_body_is_served_untouched() {
        // Only the list shape is filtered. Anything else is somebody else's answer, and a proxy that
        // rewrote it would be guessing.
        let s = state();
        assert!(filter_activities_body(&s, "user-1", b"{\"message\":\"nope\"}").is_none());
        assert!(filter_activities_body(&s, "user-1", b"not json").is_none());
    }

    #[test]
    fn the_preference_is_read_per_caller() {
        let s = state();
        set_audit_visible(&s, "user-1", false).unwrap();
        assert!(!audit_visible_for(&s, "user-1"));
        assert!(audit_visible_for(&s, "user-2"), "another person is unaffected");
    }
}
