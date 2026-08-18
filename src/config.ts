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
  // Hard cap on any request body we will buffer. The router reads bodies before it can
  // know who is calling, so this is the one limit that must not depend on auth.
  maxBodyKb: Number(process.env.MAX_BODY_KB ?? 1024),
  // Refuse to enrol a peer from a share link that carries no password. Recommended
  // whenever the sidecar is reachable from the public internet: without it, possession
  // of a link is the whole credential. A link's own password and expiry are ALWAYS
  // enforced regardless of this setting.
  requireSharePassword: process.env.REQUIRE_SHARE_PASSWORD === 'true',
  // Optional storage cap on the bot users that own the stubs (0 = no quota). They only
  // ever store ~2KB per photo and ~2MB per video, so a cap bounds what a stolen utility
  // key could write — but set it too low and materialisation silently starts failing.
  utilityQuotaMb: Number(process.env.UTILITY_QUOTA_MB ?? 0),
  // Peer URLs on private ranges are normal for LAN and tailnet deployments, so they are
  // allowed by default. Set false on a public-facing host to stop a peer URL being aimed
  // at internal services.
  allowPrivatePeers: process.env.ALLOW_PRIVATE_PEERS !== 'false',
};
if (!CFG.apiKey) { console.error('IMMICH_API_KEY required'); process.exit(1); }
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const UTILITY_SUFFIX = ' (via shared albums)';
