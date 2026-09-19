// check-contrast.mjs — the token pairs a person reads text in, at WCAG AA. See AGENTS.md, "Extract
// what repeats": a design system is worth nothing if its greys are unreadable, and "looks fine" is
// not a measurement.
//
// AA is 4.5:1 for text at these sizes. Every pair below is used for small text somewhere, so every
// pair has to clear it — in both colour schemes, since the tokens define both.
import fs from 'node:fs';

const CSS = 'src/web/ui/lib/tokens.css';
const AA = 4.5;
const PAIRS = [
  ['ink', 'surface'],
  ['ink', 'sunken'],
  ['ink-muted', 'surface'],
  ['accent', 'surface'],
  ['accent-ink', 'accent'],
  ['danger', 'surface'],
  ['ok', 'surface'],
];

const css = fs.readFileSync(CSS, 'utf8');
const scheme = start => {
  const from = css.indexOf(start);
  const to = css.indexOf('}', from);
  return Object.fromEntries(
    [...css.slice(from, to).matchAll(/--isa-([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
  );
};
const rgb = value => {
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
const ratio = (a, b) => {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const failures = [];
for (const [name, start] of [
  ['light', ':root {'],
  ['dark', '@media (prefers-color-scheme: dark)'],
]) {
  const tokens = scheme(start);
  for (const [fg, bg] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) {
      failures.push(`${name}: --isa-${fg} or --isa-${bg} is not defined`);
      continue;
    }
    const got = ratio(tokens[fg], tokens[bg]);
    if (got < AA) failures.push(`${name}: --isa-${fg} on --isa-${bg} is ${got.toFixed(2)}:1, needs ${AA}:1`);
  }
}
if (failures.length) {
  console.error('contrast below AA for text:');
  for (const line of failures) console.error('  ' + line);
  process.exit(1);
}
console.log(`contrast: ${PAIRS.length} pairs, both schemes, all at or above AA (${AA}:1)`);
