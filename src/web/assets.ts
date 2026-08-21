/** web/assets.ts — serves the committed dist/ artifacts and fills their %%TOKENS%%, escaped. See http-router.md. */
import fs from 'node:fs';
import path from 'node:path';
import { CFG, ROUTE_PREFIX } from '../config.ts';

const read = (name: string) => {
  const file = path.join(import.meta.dirname, 'dist', name);
  try {
    // dist hardcodes the default prefix so it stays valid standalone; rewriting here keeps
    // config.ROUTE_PREFIX the single source of truth.
    return fs.readFileSync(file, 'utf8').replaceAll('/immich-shared-albums/', `${ROUTE_PREFIX}/`);
  } catch {
    console.error(`asset missing at ${file} — run: npm run build:web`);
    return '';
  }
};

export const DIST = {
  'panel.js': read('panel.js'),
  'accept.js': read('accept.js'),
  'share.js': read('share.js'),
  'panel.css': read('panel.css'),
  'accept.css': read('accept.css'),
  'share.css': read('share.css'),
  'sign-in.css': read('sign-in.css'),
} as const;

const PANEL_HTML = read('panel.html');
const ACCEPT_HTML = read('accept.html');
const SHARE_HTML = read('share.html');
const SIGN_IN_HTML = read('sign-in.html');

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const panelPage = () => PANEL_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name));

export const acceptPage = () => ACCEPT_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name));

export const signInPage = (what: string) =>
  SIGN_IN_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name)).replaceAll('%%WHAT%%', escapeHtml(what));

export const sharePage = (meta: { albumName?: string; coverUrl?: string } | null) =>
  SHARE_HTML.replaceAll('%%ALBUM%%', escapeHtml(meta?.albumName || 'Shared album')).replace(
    /<meta property="og:image" content="%%COVER%%"\s*\/?>/,
    meta?.coverUrl ? `<meta property="og:image" content="${escapeHtml(meta.coverUrl)}"/>` : ''
  );
