/** sync/audit.ts — the public trail this addon leaves in an album's comments. See docs/post-v1-reunification-design.md §7. */

import { log } from '../config.ts';
import { seenActAdd, seenActHas } from '../state.ts';
import { ensureHouseBot } from './house-bot.ts';
import { postComment } from './comments.ts';

/**
 * Leave one audit line in an album's comments, as this household's own bot, at most once per event.
 *
 * The trail is what makes a mismatched reunion recoverable rather than mysterious: the two albums
 * were paired by NAME alone, so when the pairing is wrong the people involved are the only ones who
 * can tell — and they can only tell if the album says what happened to it.
 *
 * It runs where the owner's credential is in hand because the bot has to BE a member to comment, and
 * only an album's owner can grant that (verified: the household admin key answers `403
 * albumUser.create` on an album a different person owns). Adoption grants the bot its membership in
 * the same request, so that is the moment this has; there is no later one.
 *
 * Idempotent by LEDGER, not by hope. The loops retry a step until it settles, so a naive write leaves
 * a second identical line on every pass. `seenActAdd` is the record `syncCommentsOnce` already
 * consults, and `local:<activityId>` is how a line we posted is kept from being pushed back to the
 * peer as though a person had written it.
 */
export async function auditLine(
  mappingId: string,
  albumId: string,
  event: string,
  text: string
): Promise<boolean> {
  const tag = `audit:${event}:${albumId}`;
  if (seenActHas(tag)) return false;
  try {
    const bot = await ensureHouseBot();
    if (!bot.apiKey) return false;
    const posted = await postComment(albumId, text, bot.apiKey);
    seenActAdd(tag, mappingId);
    if (posted?.id) seenActAdd(`local:${posted.id}`, mappingId);
    log(`audit on "${albumId.slice(0, 8)}": ${text}`);
    return true;
  } catch (e) {
    // Deliberately not fatal, and deliberately not tagged: the reunion itself is already recorded in
    // state.db, and a trail line is worth a retry rather than worth failing the act. Leaving the tag
    // unwritten is what makes the next attempt try again.
    log(`could not leave the audit line on album ${albumId.slice(0, 8)}: ${(e as Error).message}`);
    return false;
  }
}
