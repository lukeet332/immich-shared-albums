/** web/assets.ts — serves the committed dist/ artifacts and fills their %%TOKENS%%, escaped. See http-router.md. */
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../config.ts';

const read = (name: string) => {
  const file = path.join(import.meta.dirname, 'dist', name);
  try {
    // The prefix is FIXED (see config.ROUTE_PREFIX: a member's share page probes the origin's
    // prefix, so it could never vary per install) — dist hardcodes it and is served verbatim.
    return fs.readFileSync(file, 'utf8');
  } catch {
    console.error(`asset missing at ${file} — run: npm run build:web`);
    return '';
  }
};

export const DIST = {
  'panel.js': read('panel.js'),
  'accept.js': read('accept.js'),
  'share.js': read('share.js'),
  'me.js': read('me.js'),
  'panel.css': read('panel.css'),
  'accept.css': read('accept.css'),
  'share.css': read('share.css'),
  'me.css': read('me.css'),
  'sign-in.css': read('sign-in.css'),
} as const;

const PANEL_HTML = read('panel.html');
const ACCEPT_HTML = read('accept.html');
const SHARE_HTML = read('share.html');
const ME_HTML = read('me.html');
const SIGN_IN_HTML = read('sign-in.html');

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const panelPage = () => PANEL_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name));

export const acceptPage = () => ACCEPT_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name));

export const mePage = () => ME_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name));

export const signInPage = (what: string) =>
  SIGN_IN_HTML.replaceAll('%%HOUSEHOLD%%', escapeHtml(CFG.name)).replaceAll('%%WHAT%%', escapeHtml(what));

export const sharePage = (endpointToken: string, meta: { albumName?: string; coverUrl?: string } | null) =>
  SHARE_HTML.replaceAll('%%ENDPOINT%%', escapeHtml(endpointToken))
    .replaceAll('%%ALBUM%%', escapeHtml(meta?.albumName || 'Shared album'))
    .replace(
      /<meta property="og:image" content="%%COVER%%"\s*\/?>/,
      meta?.coverUrl ? `<meta property="og:image" content="${escapeHtml(meta.coverUrl)}"/>` : ''
    );
