// check-tokens.mjs — a colour is written in lib/tokens.css, and nowhere else. See AGENTS.md,
// "Extract what repeats": an extraction is not finished while a literal of it survives elsewhere.
//
// A RATCHET, not a wall: the files still carrying literals are listed with today's counts, and the
// list may only shrink. Lowering a number as a screen is converted is the point; raising one, or
// adding a file, fails.
import fs from 'node:fs';
import path from 'node:path';

const UI = 'src/web/ui';
const OWNS_COLOURS = path.join(UI, 'lib/tokens.css');
/** Empty on purpose: every stylesheet is on the tokens, so the ratchet is a wall. A file listed
 *  here is a file that still needs converting — and the list may only shrink. */
const ALLOWED = {};
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([0-9][^)]*\)|hsla?\([^)]*\)/g;

const files = [];
const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'dist') walk(full);
    } else if (/\.(css|ts|tsx)$/.test(entry.name) && full !== OWNS_COLOURS) files.push(full);
  }
};
walk(UI);

const over = [];
const tighten = [];
for (const file of files) {
  const found = (fs.readFileSync(file, 'utf8').match(COLOUR) || []).length;
  const allowed = ALLOWED[file] ?? 0;
  if (found > allowed) over.push(`${file}: ${found} colour literal(s), ${allowed} allowed`);
  if (found < allowed) tighten.push(`${file}: ${found} left, allowance says ${allowed} — lower it`);
}
if (over.length) {
  console.error('colour literals outside lib/tokens.css:');
  for (const line of over) console.error('  ' + line);
  console.error(
    'Move the value into lib/tokens.css and use var(--isa-…) — see AGENTS.md, "Extract what repeats".'
  );
  process.exit(1);
}
if (tighten.length) {
  console.error('the ratchet is loose — these allowances can come down:');
  for (const line of tighten) console.error('  ' + line);
  process.exit(1);
}

// A SHIPPED stylesheet must carry its tokens, not point at them. The sidecar serves `dist/` under
// `/immich-shared-albums/assets/`, so an un-inlined `@import` resolves to a path that answers 404
// and the page renders with no token at all — which is a page that looks broken, not unstyled.
const DIST = 'src/web/dist';
const withImport = fs.existsSync(DIST)
  ? fs
      .readdirSync(DIST)
      .filter(f => f.endsWith('.css'))
      .filter(f => /@import/.test(fs.readFileSync(path.join(DIST, f), 'utf8')))
  : [];
if (withImport.length) {
  console.error('built stylesheets still carrying an @import (its target is not served):');
  for (const f of withImport) console.error(`  ${path.join(DIST, f)}`);
  console.error('Bundle the stylesheet so the import is inlined — see scripts/build-web.mjs.');
  process.exit(1);
}

console.log(
  `colours live in ${OWNS_COLOURS} (${Object.keys(ALLOWED).length} file(s) still on the ratchet), ` +
    `and every built stylesheet carries its tokens`
);
