#!/usr/bin/env node
/**
 * build-web.mjs — build src/web/ui (the Preact workspace) into committed artifacts in src/web/dist:
 * <page>.js + <page>.css per bundled page, and a prerendered <page>.html document for every page.
 *
 * The OUTPUT IS COMMITTED on purpose. The Dockerfile is seven lines that copy `src/` and run
 * `node index.ts` with no npm install at all; committing dist means deployment builds nothing.
 * The pre-commit hook runs this, so dist cannot drift from its source, and CI rebuilds and fails
 * on any diff. Runtime values (household name, og tags) stay as %%TOKENS%% in the prerendered
 * HTML — web/assets.ts substitutes them, escaped, per request.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';

const OUT = 'src/web/dist';
mkdirSync(OUT, { recursive: true });

const BUNDLED_PAGES = ['panel', 'accept', 'share'];
const ALL_PAGES = [...BUNDLED_PAGES, 'sign-in'];

const report = file => console.log(`built ${file} — ${(statSync(file).size / 1024).toFixed(1)}KB`);

for (const page of BUNDLED_PAGES) {
  await build({
    entryPoints: [`src/web/ui/pages/${page}/index.tsx`],
    outfile: `${OUT}/${page}.js`,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    legalComments: 'none',
    logLevel: 'warning',
  });
  report(`${OUT}/${page}.js`);
  report(`${OUT}/${page}.css`);
}

// sign-in has no script — only its stylesheet ships
await build({
  entryPoints: ['src/web/ui/pages/sign-in/sign-in.css'],
  outfile: `${OUT}/sign-in.css`,
  minify: true,
  logLevel: 'warning',
});
report(`${OUT}/sign-in.css`);

for (const page of ALL_PAGES) {
  const exportName = page.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase()) + 'Document';
  const prerender = await build({
    stdin: {
      contents: `import { renderToString } from 'preact-render-to-string';
                 import { ${exportName} } from './src/web/ui/pages/${page}/document.tsx';
                 export const html = '<!doctype html>' + renderToString(<${exportName} />);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'empty' },
    logLevel: 'warning',
  });
  const { html } = await import(
    `data:text/javascript;base64,${Buffer.from(prerender.outputFiles[0].text).toString('base64')}`
  );
  writeFileSync(`${OUT}/${page}.html`, html + '\n');
  report(`${OUT}/${page}.html`);
}
