/** config.ts — configuration, logger, and the names this addon claims. See config.md. */

export const SIDECAR_VERSION = '0.5.0'; // x-release-please-version
const apiKey = process.env.IMMICH_API_KEY;
if (!apiKey) {
  console.error('IMMICH_API_KEY required');
  process.exit(1);
}

export const CFG = {
  immichUrl: process.env.IMMICH_URL || 'http://immich-server:2283',
  apiKey,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  name: process.env.HOUSEHOLD_NAME || 'Unnamed household',
  port: Number(process.env.PORT || 8300),
  dataDir: process.env.DATA_DIR || '/data',
  pollMs: Number(process.env.POLL_MS || 20000),
  template: process.env.ALBUM_TEMPLATE || '{name}',
  cacheMaxMb: Number(process.env.CACHE_MAX_MB ?? 512),
  maxBodyKb: Number(process.env.MAX_BODY_KB ?? 1024),
  requireSharePassword: process.env.REQUIRE_SHARE_PASSWORD === 'true',
  utilityQuotaMb: Number(process.env.UTILITY_QUOTA_MB ?? 0),
  shareUserDirectory: process.env.SHARE_USER_DIRECTORY !== 'false',
  allowPrivatePeers: process.env.ALLOW_PRIVATE_PEERS !== 'false',
};
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const UTILITY_SUFFIX = ' (via shared albums)';

export const UTILITY_EMAIL_DOMAIN = 'immich-shared-albums.local';

export const BOT_PREFIX = {
  person: 'person-',
  helper: 'shared-',
} as const;

export const personName = (name?: string) => (name || '').replace(/\s*\(via .*\)\s*$/, '').trim();

export const markerName = {
  person: (personName: string, peerName: string) => `${personName} (via ${peerName} server)`,
};

export const isUtilityEmail = (email?: string) => !!email && email.endsWith(`@${UTILITY_EMAIL_DOMAIN}`);

export const ROUTE_PREFIX = '/immich-shared-albums';
