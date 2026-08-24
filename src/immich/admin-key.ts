/** immich/admin-key.ts — the admin key's required scopes, and the boot check that verifies them. See local-immich-api.md. */
import { CFG, log } from '../config.ts';

// The full set the sidecar exercises on the admin account. Deliberately absent: every asset
// write/delete, library/backup/job/server scopes, and all apiKey.* — a leaked key cannot touch
// photos, settings, or mint itself a broader key.
export const REQUIRED_ADMIN_PERMISSIONS = [
  'adminUser.create',
  'adminUser.read',
  'adminUser.update',
  'adminUser.delete',
  'album.read',
  'albumUser.create',
  'albumUser.update',
  'albumUser.delete',
  'asset.read',
  'asset.view',
  'asset.download',
  'activity.read',
  'activity.statistics',
  'user.read',
  'userProfileImage.read',
  'sharedLink.read',
] as const;

/** Only needed to mint bot keys on OAuth-only instances (the passwordLogin toggle). */
export const OAUTH_ONLY_PERMISSIONS = ['systemConfig.read', 'systemConfig.update'] as const;

// The key cannot list its own permissions (apiKey.read is excluded on purpose), so verification
// is by probe: one required scope and one optional scope, each answered by a cheap GET.
export async function verifyAdminKeyAtBoot(): Promise<void> {
  const probe = async (path: string) => {
    try {
      const r = await fetch(`${CFG.immichUrl}/api${path}`, {
        headers: { 'x-api-key': CFG.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      return r.status;
    } catch {
      return 0; // Immich unreachable — not this check's business, startup retries elsewhere
    }
  };
  const admin = await probe('/admin/users');
  if (admin === 403) {
    log('ADMIN KEY IS MISSING REQUIRED PERMISSIONS — cross-server sharing will not work.');
    log(`Create the key on an admin account with exactly: ${REQUIRED_ADMIN_PERMISSIONS.join(', ')}`);
    log('(deploy/api-key.md explains each permission. "all" also works, with a wider blast radius.)');
    return;
  }
  const sysCfg = await probe('/system-config');
  if (sysCfg === 403) {
    log(
      'admin key verified (scoped). Note: no systemConfig scope — fine unless this Immich is ' +
        'OAuth-only, which needs systemConfig.read+update to mint bot keys.'
    );
    return;
  }
  if (admin === 200) log('admin key verified.');
}
