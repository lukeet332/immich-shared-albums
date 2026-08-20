/** web/banner.ts — loads banner.js once at startup. It is both served at. See http-router.md. */
import fs from 'node:fs';
import { log, ROUTE_PREFIX } from '../config.ts';

export let BANNER_JS = '';
try {
  BANNER_JS = fs
    .readFileSync(new URL('./banner/banner.js', import.meta.url), 'utf8')
    .replaceAll('/immich-shared-albums/', `${ROUTE_PREFIX}/`);
} catch {
  log('banner.js not bundled — share pages will be served un-injected');
}
