/**
 * web/banner.ts — loads banner.js once at startup. It is both served at
 * <prefix>/banner.js and injected into an origin's /share pages (see passthrough.ts),
 * so it lives in one place. Empty string if not bundled (share pages serve un-injected).
 */
import fs from 'node:fs';
import { log, ROUTE_PREFIX } from '../config.ts';

export let BANNER_JS = '';
try {
  // banner.js hardcodes the default prefix so it stays valid standalone (see banner/preview.html);
  // rewriting it here keeps config.ROUTE_PREFIX the single source of truth.
  BANNER_JS = fs
    .readFileSync(new URL('./banner/banner.js', import.meta.url), 'utf8')
    .replaceAll('/immich-shared-albums/', `${ROUTE_PREFIX}/`);
} catch {
  log('banner.js not bundled — share pages will be served un-injected');
}
