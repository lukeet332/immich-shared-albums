/** sync/house-bot.ts — this household's own bot: the account that joins an album so the sidecar can read it, and speaks for the addon in comments. See sync-loops.md. */

import { BOT_PREFIX, UTILITY_EMAIL_DOMAIN } from '../config.ts';
import type { Contributor } from '../store.ts';
import { immichJson } from '../immich/client.ts';
import { ensureUtilityUser } from '../immich/contributors.ts';
import type { Creds } from '../immich/access.ts';

/** What the bot may do, and nothing else: read an album and its assets, and comment. Deliberately
 *  no asset write, no album write, no membership write — it joins albums as a VIEWER, so it can
 *  never add, move or remove a photo, and `apiKey.create` is absent so it cannot widen itself. */
export const HOUSE_BOT_PERMISSIONS = [
  'album.read',
  'asset.read',
  'asset.view',
  'activity.create',
  'activity.read',
];

/** The bot, provisioned on first use. Lazy on purpose: a household that never reunifies anything
 *  and never generates an audit line has no extra account sitting in its member list. */
export async function ensureHouseBot(): Promise<Contributor> {
  const slug = `${BOT_PREFIX.house}bot`;
  // The display name lands in Immich's People list, so it says what it is; ensureUtilityUser
  // appends UTILITY_SUFFIX, giving "Shared albums (via shared albums)".
  return ensureUtilityUser('Shared albums', {
    stateKey: slug,
    email: `${slug}@${UTILITY_EMAIL_DOMAIN}`,
    permissions: HOUSE_BOT_PERMISSIONS,
  });
}

/**
 * Add the bot to an album as a viewer, using the album owner's own credentials.
 *
 * The album's owner runs this from their own request, so the membership is their action — and it
 * has to be a membership, because `GET /albums` is scoped per credential: the household admin key
 * cannot read an album a different person owns (verified: 400, and the album is absent from its
 * list). A viewer is the least it can be while still being able to read the photos.
 *
 * Idempotent: Immich answers 200 for a user who is already a member, silently ignoring it, so this
 * checks the membership list rather than trusting the status code.
 */
export async function addHouseBotToAlbum(albumId: string, ownerCreds: Creds): Promise<void> {
  const bot = await ensureHouseBot();
  const album = await immichJson(`/albums/${albumId}?withoutAssets=true`, {}, ownerCreds);
  const already = (album?.albumUsers || []).some(au => au.user?.id === bot.userId);
  if (already) return;
  await immichJson(
    `/albums/${albumId}/users`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumUsers: [{ userId: bot.userId, role: 'viewer' }] }),
    },
    ownerCreds
  );
}
