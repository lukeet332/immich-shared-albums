/**
 * immich/migrate-domain.ts — one-time, idempotent rename of bot accounts onto the current
 * UTILITY_EMAIL_DOMAIN.
 *
 * When the bot email domain changes (see config.ts UTILITY_EMAIL_DOMAIN), existing accounts keep
 * their old address — they are resolved by state key (person id), not email, so nothing breaks and
 * no duplicate is created. But the old address is what a human sees in Immich's People list / album
 * picker, and reading "@…invalid" there is exactly what we're fixing. So on boot we rename any bot
 * account still on a legacy domain to the same local-part on the current domain.
 *
 * Safe by construction: only accounts whose email is a LEGACY_UTILITY_DOMAINS match are touched,
 * only the domain half changes, and re-running finds none (idempotent). Best-effort — a failure on
 * one account is logged and skipped, never fatal to boot.
 */
import { log, UTILITY_EMAIL_DOMAIN, LEGACY_UTILITY_DOMAINS } from '../config.ts';
import { immichJson, jsonBody } from './client.ts';

const onLegacyDomain = (email?: string) =>
  !!email && LEGACY_UTILITY_DOMAINS.some(d => email.endsWith(`@${d}`));

export async function migrateUtilityDomain(): Promise<void> {
  let users;
  try {
    // Active accounts only: soft-deleted bots are already hidden from pickers and purge on their
    // own, so renaming them buys nothing and can error on an account that is going away.
    users = await immichJson('/admin/users');
  } catch (e) {
    log(`utility-domain migration skipped (cannot list users): ${e.message}`);
    return;
  }
  const stale = (users as { id: string; email: string }[]).filter(u => onLegacyDomain(u.email));
  if (!stale.length) return;
  let renamed = 0;
  for (const u of stale) {
    const email = `${u.email.split('@')[0]}@${UTILITY_EMAIL_DOMAIN}`;
    try {
      await immichJson(`/admin/users/${u.id}`, { ...jsonBody({ email }), method: 'PUT' });
      renamed++;
    } catch (e) {
      log(`utility-domain migration: could not rename ${u.email}: ${e.message}`);
    }
  }
  if (renamed) log(`utility-domain migration: renamed ${renamed} bot account(s) to @${UTILITY_EMAIL_DOMAIN}`);
}
