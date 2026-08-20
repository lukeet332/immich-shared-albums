#!/usr/bin/env node
/**
 * check-cycles.mjs — enforce the rule ARCHITECTURE.md already states: dependencies point
 * downward, and there are no load-time import cycles.
 *
 * This existed only as prose until a cycle (engine -> invites -> mirror -> engine) was introduced
 * and then verified by hand. A convention nothing checks is a convention that breaks again.
 *
 * Deliberately dumb: a regex over static import statements, no parser, no dependencies. It only
 * needs to catch the load-time cycles that actually bite, so `import type` (erased at runtime)
 * and dynamic `await import()` (evaluated later) are both ignored on purpose.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(p);
  }
})(ROOT);

const rel = p => path.relative(ROOT, p).replaceAll(path.sep, '/');
const graph = new Map();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const deps = new Set();
  // `import ... from './x.ts'` / `export ... from './x.ts'`, but never `import type`
  const re = /^\s*(?:import|export)\s+(?!type\s)(?:[^;'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (fs.existsSync(target)) deps.add(rel(target));
  }
  graph.set(rel(file), deps);
}

// iterative DFS with an explicit stack, so the cycle can be printed as a readable path
const state = new Map(); // 0 = unvisited, 1 = on stack, 2 = done
const cycles = [];
for (const start of graph.keys()) {
  if (state.get(start)) continue;
  const stack = [[start, [...(graph.get(start) ?? [])]]];
  const pathStack = [start];
  state.set(start, 1);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const next = frame[1].shift();
    if (next === undefined) {
      state.set(frame[0], 2);
      stack.pop();
      pathStack.pop();
      continue;
    }
    if (state.get(next) === 1) {
      const at = pathStack.indexOf(next);
      cycles.push([...pathStack.slice(at), next].join(' -> '));
      continue;
    }
    if (state.get(next) === 2) continue;
    state.set(next, 1);
    pathStack.push(next);
    stack.push([next, [...(graph.get(next) ?? [])]]);
  }
}

if (cycles.length) {
  console.error(`import cycles found (${cycles.length}):\n`);
  for (const c of [...new Set(cycles)]) console.error(`  ${c}`);
  console.error('\nBreak the cycle by extracting the shared piece into its own module.');
  console.error('See src/ARCHITECTURE.md — dependencies point downward.');
  process.exit(1);
}
console.log(`no import cycles (${files.length} modules)`);
