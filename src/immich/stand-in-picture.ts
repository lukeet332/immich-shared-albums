/** immich/stand-in-picture.ts — whose face an account of ours wears. See local-immich-api.md. */

/** What to do about the profile picture on one of our own utility accounts. */
export type PicturePlan = 'leave' | 'wear';

/**
 * The picture an account of ours should be given.
 *
 * A person on a linked server gets one account here that does two jobs — it owns their mirrored
 * photos, and it is what a human picks in Immich's album picker to share with them. Both jobs put it
 * in front of a person: an album's member list, and the picker. The addon's own picture belongs on
 * the account that IS the addon; on a stand-in for a person it reads as "shared with a bot" when the
 * album is shared with your mother. Their own avatar, when they have one, arrives from their server
 * through `syncAvatar` — and when they have none, Immich's own initial is the honest picture.
 */
export function picturePlanFor(account: {
  /** True when the account stands in for a person who lives on a linked server. */
  representsPerson: boolean;
  hasPicture: boolean;
}): PicturePlan {
  if (account.representsPerson) return 'leave';
  return account.hasPicture ? 'leave' : 'wear';
}
