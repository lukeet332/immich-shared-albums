#!/usr/bin/env node
/**
 * check-runtime.mjs — prove every module actually LOADS under the runtime.
 *
 * Node runs this project's TypeScript in strip-only mode: it erases types and refuses anything
 * needing a real transform — parameter properties, enums, namespaces. `tsc --noEmit` accepts all
 * three, so the type gate can be perfectly green while the sidecar cannot boot. That happened:
 * `constructor(readonly value: string)` passed typecheck, lint and format, then crashed the
 * container on startup with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 *
 * `node --check` is NOT the tool for this — it parses as plain JavaScript and rejects all
 * TypeScript. Only an actual import applies type stripping, so that is what this does. Runtime
 * errors (no Immich to reach, no data dir) are expected and ignored; the only failures that count
 * are the ones that mean "this file cannot be loaded at all".
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.IMMICH_API_KEY ||= 'check-runtime-only';
process.env.DATA_DIR ||= '/tmp/check-runtime';

const root = join(import.meta.dirname, '..', 'src');
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // the panel is compiled by esbuild for browsers, not loaded by node
      if (e.name !== 'panel') walk(p);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      // index.ts starts the server and the sync loops; everything it imports is checked anyway
      if (e.name !== 'index.ts') files.push(p);
    }
  }
})(root);

const fatal = ['ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', 'ERR_MODULE_NOT_FOUND', 'ERR_SYNTAX_ERROR'];
let bad = 0;

for (const f of files) {
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    const isSyntax = e instanceof SyntaxError || fatal.includes(e?.code);
    if (!isSyntax) continue; // could not run, but it loaded — not this gate's business
    bad++;
    console.error(`\n${relative(root, f)}\n  ${e.code ?? 'SyntaxError'}: ${e.message.split('\n')[0]}`);
  }
}

if (bad) {
  console.error(`\n${bad} module(s) will not load under strip-only TypeScript.`);
  process.exit(1);
}
console.log(`all ${files.length} modules load under strip-only TypeScript`);
process.exit(0);
