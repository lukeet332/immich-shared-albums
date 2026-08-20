/**
 * sync/invitees.ts — who should be on a mirror, as pure set arithmetic.
 *
 * Extracted from syncMirrorMembers so it can be tested without a container. This is the only
 * code path that removes a real person from a real album, so it is worth being able to check in
 * milliseconds rather than in a seven-minute e2e run.
 */

export type InviteeDiff = { add: string[]; remove: string[] };

/**
 * Reconcile an album's local membership against the people an invitation names.
 *
 * `wanted`  — user ids the sender currently names (local ids, echoed back from our own directory)
 * `current` — ids already on the album, owner excluded
 * `local`   — our own human user ids; anything outside this is a utility user
 *
 * Two rules carry the safety here:
 *  - An EMPTY `wanted` is not "remove everyone". Nobody-named means the invitation is gone, which
 *    is a withdrawal and tears the whole mirror down elsewhere. Diffing it instead would let a
 *    failed or empty poll silently strip every member of a live album.
 *  - Only ids in `local` are ever removed. Utility users own the mirror and its stubs; removing
 *    one would strand the content it holds.
 */
export function diffInvitees({
  wanted,
  current,
  local,
}: {
  wanted: string[];
  current: string[];
  local: string[];
}): InviteeDiff {
  if (!wanted.length) return { add: [], remove: [] };
  const want = new Set(wanted);
  const have = new Set(current);
  const mine = new Set(local);
  return {
    add: local.filter(id => want.has(id) && !have.has(id)),
    remove: current.filter(id => mine.has(id) && !want.has(id)),
  };
}
