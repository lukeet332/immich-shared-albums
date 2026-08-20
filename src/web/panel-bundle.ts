/**
 * panel-bundle.ts — reads the committed page bundles at startup.
 *
 * A separate module so server.ts does not do file IO inline, and so the failure is loud: if the
 * bundle is missing the panel is blank, which is worth an explicit error rather than a 404 that
 * looks like a routing bug.
 */
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string) => {
  const file = path.join(import.meta.dirname, name);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    console.error(`bundle missing at ${file} — run: npm run build:panel`);
    return '';
  }
};

export const PANEL_BUNDLE = read('panel.bundle.js');
export const ACCEPT_BUNDLE = read('accept.bundle.js');
