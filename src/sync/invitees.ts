/** sync/invitees.ts — who should be on a mirror, as pure set arithmetic. See sync-loops.md. */

export type InviteeDiff = { add: string[]; remove: string[] };

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
