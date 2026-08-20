/** web/panel-bundle.ts — reads the committed page bundles at startup. See http-router.md. */
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
