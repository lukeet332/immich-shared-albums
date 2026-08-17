/**
 * web/banner.ts — loads banner.js once at startup. It is both served at
 * /sidecar/banner.js and injected into an origin's /share pages (see passthrough.ts),
 * so it lives in one place. Empty string if not bundled (share pages serve un-injected).
 */
import fs from 'node:fs';
import { log } from '../config.ts';

export let BANNER_JS = '';
try { BANNER_JS = fs.readFileSync(new URL('./banner/banner.js', import.meta.url), 'utf8'); }
catch { log('banner.js not bundled — share pages will be served un-injected'); }
