#!/usr/bin/env node
/**
 * check-headers.mjs — every source file opens with one line saying what it is and where its doc is,
 * and that pointer actually resolves.
 *
 * The convention is in AGENTS.md. This exists because a pointer to a doc that has been renamed or
 * deleted is worse than no pointer: it sends the next reader — or the next agent — somewhere
 * useless, and nothing else in the codebase would catch it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'src');
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.bundle.js')) files.push(path);
  }
})(root);

const problems = [];
for (const file of files) {
  const firstLine = readFileSync(file, 'utf8').split('\n')[0];
  const shown = relative(root, file);

  if (!/^\/\*\*.*\*\/$/.test(firstLine)) {
    problems.push(`${shown}: no one-line header. See AGENTS.md.`);
    continue;
  }
  const pointer = firstLine.match(/See ([^\s]+\.md)\./);
  if (!pointer) {
    problems.push(`${shown}: header names no doc — add "See <doc>.md."`);
    continue;
  }
  const shape = firstLine.match(/^\/\*\*\s*(\S+) — (.+?)\s*See [^\s]+\.md\.\s*\*\/$/);
  if (!shape) {
    problems.push(`${shown}: header must read "<path> — <description>. See <doc>.md."`);
  } else {
    if (shape[1] !== shown.split(sep).join('/'))
      problems.push(`${shown}: header names "${shape[1]}" — it must name its own path.`);
    // A mechanical strip or a bad merge leaves the description cut off mid-clause. It still
    // reads like a sentence, so only the shape gives it away.
    if (/(^|\s)(at|the|of|and|to|a|an|in|for|with|by)\s*[.,;]?$|[,;]$/.test(shape[2].trim()))
      problems.push(`${shown}: header description ends mid-sentence — "…${shape[2].trim().slice(-40)}"`);
  }
  const target = resolve(dirname(file), pointer[1]);
  if (!existsSync(target)) {
    problems.push(`${shown}: header points at ${pointer[1]}, which does not exist.`);
  }
}

if (problems.length) {
  console.error(`file-header problems (${problems.length}):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`all ${files.length} source file headers are well-formed and point at a real doc`);
