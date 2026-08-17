/**
 * config.ts — process configuration, the shared logger, and small string constants.
 * The single source of truth for env-derived settings; every other module reads CFG here.
 */
import crypto from 'node:crypto';

export const SIDECAR_VERSION = '0.4.1'; // x-release-please-version
export const CFG = {
  immichUrl: process.env.IMMICH_URL || 'http://immich-server:2283',
  apiKey: process.env.IMMICH_API_KEY,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  name: process.env.HOUSEHOLD_NAME || 'Unnamed household',
  port: Number(process.env.PORT || 8300),
  dataDir: process.env.DATA_DIR || '/data',
  pollMs: Number(process.env.POLL_MS || 20000),
  template: process.env.ALBUM_TEMPLATE || '{name}',
  // bounded LRU byte-cache for streamed previews (0 disables). A cache, not storage:
  // capped, reclaimable, invisible to libraries — delete the folder any time.
  cacheMaxMb: Number(process.env.CACHE_MAX_MB ?? 512),
};
if (!CFG.apiKey) { console.error('IMMICH_API_KEY required'); process.exit(1); }
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const UTILITY_SUFFIX = ' (via shared albums)';
