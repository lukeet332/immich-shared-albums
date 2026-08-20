#!/usr/bin/env node
/**
 * build-panel.mjs — compile the two front-end pages (panel, accept) into committed bundles.
 *
 * The OUTPUT IS COMMITTED on purpose. The Dockerfile is seven lines that copy `src/` and run
 * `node index.ts` with no npm install at all, and that simplicity is worth more than keeping a
 * generated file out of git. Committing the bundle means deployment gains nothing to do: no build
 * stage, no network during image build, no devDependencies in the image.
 *
 * The pre-commit hook runs this, so the committed bundle cannot drift from its source. CI checks
 * the same way — build, then fail if git reports a diff.
 *
 * Only these pages are compiled. The sidecar itself still runs TypeScript directly.
 */
import { build } from 'esbuild';

// Two separate bundles on purpose: the joining page is public and must not download the admin
// panel's code, and the panel must not carry the accept flow.
const entries = [
  ['src/web/panel/index.tsx', 'src/web/panel.bundle.js'],
  ['src/web/accept/index.tsx', 'src/web/accept.bundle.js'],
];

for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    legalComments: 'none',
    logLevel: 'warning',
  });

  const { size } = await import('node:fs').then(fs => fs.promises.stat(outfile));
  console.log(`built ${outfile} — ${(size / 1024).toFixed(1)}KB`);
}
