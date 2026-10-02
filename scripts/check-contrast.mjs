// check-contrast.mjs — every token pair a person reads, measured. See AGENTS.md, "Extract what
// repeats": a design system is worth nothing if its greys are unreadable, and "looks fine" is not a
// measurement.
//
// Two floors, because WCAG has two: TEXT is 4.5:1 (AA, 1.4.3) and a UI SHAPE — the switch's thumb
// against its own track — is 3:1 (1.4.11). Every pair below is used somewhere, so every pair has to
// clear its floor in BOTH schemes, since the tokens define both. A pair's third element overrides the
// text floor; a token may also name another token, which `rgb` resolves so a var() still measures.
import fs from 'node:fs';

const CSS = 'src/web/ui/lib/tokens.css';
const TEXT = 4.5;
const SHAPE = 3;
const PAIRS = [
  ['ink', 'surface'],
  ['ink', 'sunken'],
  ['ink', 'surface-sunken-strong'],
  ['ink', 'danger-surface'],
  ['ink-muted', 'surface'],
  ['ink-muted', 'sunken'],
  ['ink-subtle', 'surface'],
  ['ink-subtle', 'sunken'],
  ['accent', 'surface'],
  ['accent', 'accent-container'],
  ['accent-ink', 'accent'],
  ['danger', 'surface'],
  ['danger', 'danger-surface'],
  ['ok', 'surface'],
  // The switch's moving part against the track it moves on, in BOTH states: a shape, not a word.
  ['switch-thumb-off', 'switch-track-off', SHAPE],
  ['switch-thumb-on', 'switch-track-on', SHAPE],
];

const css = fs.readFileSync(CSS, 'utf8');
const scheme = start => {
  const from = css.indexOf(start);
  const to = css.indexOf('}', from);
  return Object.fromEntries(
    [...css.slice(from, to).matchAll(/--isa-([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
  );
};
const rgb = (value, tokens) => {
  const named = /^var\(\s*--isa-([a-z0-9-]+)\s*\)$/.exec(value);
  if (named) return rgb(tokens[named[1]], tokens);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
  const parts = /rgba?\(([^)]+)\)/.exec(value);
  return parts
    ? parts[1]
        .split(',')
        .slice(0, 3)
        .map(n => Number(n.trim()))
    : null;
};
const luminance = ([r, g, b]) => {
  const channel = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b, tokens) => {
  const [hi, lo] = [luminance(rgb(a, tokens)), luminance(rgb(b, tokens))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const failures = [];
for (const [name, start] of [
  ['light', ':root {'],
  ['dark', '@media (prefers-color-scheme: dark)'],
]) {
  const tokens = scheme(start);
  for (const [fg, bg, floor = TEXT] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) {
      failures.push(`${name}: --isa-${fg} or --isa-${bg} is not defined`);
      continue;
    }
    const got = ratio(tokens[fg], tokens[bg], tokens);
    if (got < floor)
      failures.push(`${name}: --isa-${fg} on --isa-${bg} is ${got.toFixed(2)}:1, needs ${floor}:1`);
  }
}
if (failures.length) {
  console.error('token pairs below their floor:');
  for (const line of failures) console.error('  ' + line);
  process.exit(1);
}
console.log(
  `contrast: ${PAIRS.length} pairs, both schemes, all at or above AA (text ${TEXT}:1, shape ${SHAPE}:1)`
);
