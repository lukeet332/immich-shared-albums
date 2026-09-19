#!/usr/bin/env node
/**
 * demo/e2e/stage-breakdown.mjs — per-stage wall time and host cost for one rig run.
 *
 * The suite stamps each stage with an ISO timestamp and `resource-sampler.sh` records host memory
 * and per-container RSS on a tick, so a run can be attributed stage by stage rather than described
 * as one number. This is the local equivalent of reading a CI job log's `— stage:` lines, plus the
 * host cost a CI log cannot show.
 *
 * Usage:  node demo/e2e/stage-breakdown.mjs <run.log> [trace.jsonl]
 */
import fs from 'node:fs';

const [logPath, tracePath] = process.argv.slice(2);
if (!logPath) {
  console.error('usage: node demo/e2e/stage-breakdown.mjs <run.log> [trace.jsonl]');
  process.exit(2);
}

const STAGE = '— stage: ';
const stageRe = new RegExp(`^(\\S+)\\s+${STAGE}(.*)$`);
const starts = [];
const order = [];
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const m = line.match(stageRe);
  if (!m) continue;
  const name = m[2].trim();
  if (starts.some(s => s.name === name)) continue;
  order.push(name);
  starts.push({ name, at: Date.parse(m[1]) });
}
if (!starts.length) {
  console.error(`no "${STAGE}" lines with timestamps in ${logPath} — is this a current run?`);
  process.exit(2);
}

// A stage ends where the next begins; the last ends at the suite's own summary line, which is
// stamped. Falling back to `Date.now()` here would make the final stage's length depend on when
// this script was run rather than on the run — the whole table would drift between invocations.
let endAt = null;
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  if (!/\bchecks\)/.test(line) || !/(ALL PASS|FAILURES)/.test(line)) continue;
  const stamp = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  endAt = stamp ? Date.parse(stamp[1]) : null;
}
if (endAt === null) {
  console.error(`no timestamped summary line in ${logPath} — cannot close the last stage`);
  process.exit(2);
}
for (let i = 0; i < starts.length; i++) {
  starts[i].end = starts[i + 1] ? starts[i + 1].at : endAt;
}

const samples = [];
if (tracePath && fs.existsSync(tracePath)) {
  for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      samples.push(JSON.parse(line));
    } catch {
      /* a torn final line from a killed sampler is expected, not an error */
    }
  }
}
const inWindow = (a, b) => samples.filter(s => {
  const t = Date.parse(s.ts);
  return t >= a && t <= b;
});

const mib = kb => (kb ?? 0) / 1024;
const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));

console.log(`\nrun: ${logPath}`);
if (samples.length) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const lowAvail = Math.min(...samples.map(s => s.mem_avail_kb || Infinity));
  console.log(
    `trace: ${samples.length} samples, ${first.ts} → ${last.ts} | ` +
      `peak host memory used ${(mib(first.mem_total_kb) - mib(lowAvail)).toFixed(0)} MiB ` +
      `(best-available ${mib(lowAvail).toFixed(0)} MiB free)`
  );
} else if (tracePath) {
  console.log(`trace: ${tracePath} unreadable or empty`);
}

console.log(
  `\n${pad('stage', 46)}${pad('wall', 8, true)}${pad('host used Δ', 13, true)}${pad('min free', 11, true)}  note`
);
console.log('-'.repeat(96));

let wallTotal = 0;
const rows = [];
for (const s of starts) {
  const secs = Math.max(0, (s.end - s.at) / 1000);
  wallTotal += secs;
  const win = inWindow(s.at, s.end);
  const base = samples.find(x => Date.parse(x.ts) >= s.at) || win[0];
  const usedDelta = win.length && base ? mib(base.mem_avail_kb) - mib(Math.min(...win.map(x => x.mem_avail_kb))) : null;
  const minFree = win.length ? Math.min(...win.map(x => mib(x.mem_avail_kb))) : null;
  // Top consumer seen inside the window, so a stage's cost has a name attached.
  const top = win.length
    ? Object.entries(
        win
          .flatMap(x => x.containers || [])
          .reduce((acc, c) => ((acc[c.name] = Math.max(acc[c.name] || 0, c.mem_mib)), acc), {})
      ).sort((a, b) => b[1] - a[1])[0]
    : null;
  rows.push({ name: s.name, secs, usedDelta, minFree, top });
}

// Longest first: the point of the table is where the time and the load actually went.
for (const r of [...rows].sort((a, b) => b.secs - a.secs)) {
  const note = r.top ? `${r.top[0]} ${r.top[1].toFixed(0)} MiB` : '';
  console.log(
    pad(r.name.slice(0, 45), 46) +
      pad(`${r.secs.toFixed(1)}s`, 8, true) +
      pad(r.usedDelta === null ? '-' : `${r.usedDelta.toFixed(0)} MiB`, 13, true) +
      pad(r.minFree === null ? '-' : `${r.minFree.toFixed(0)} MiB`, 11, true) +
      '  ' + note
  );
}
console.log('-'.repeat(96));
console.log(`${pad(`${rows.length} stages`, 46)}${pad(`${wallTotal.toFixed(1)}s`, 8, true)}`);

if (samples.length) {
  const zram = Math.max(...samples.map(s => Number(s.zram_used) || 0));
  const swapFreeLow = Math.min(...samples.map(s => s.swap_free_kb || Infinity));
  const swapUsed = (mib(samples[0].swap_total_kb) - mib(swapFreeLow)).toFixed(0);
  const loadPeak = Math.max(...samples.map(s => Number(String(s.load).split(' ')[0]) || 0));
  console.log(
    `\nhost: peak swap used ${swapUsed} MiB of ${(mib(samples[0].swap_total_kb) / 1024).toFixed(1)} GiB ` +
      `| peak zram stored ${(zram / 1e9).toFixed(2)} GB | peak 1m load ${loadPeak.toFixed(2)}`
  );
  // zram is RAM-backed: its stored figure is compression of cold pages, not freed capacity. Growth
  // during a run is the pressure signal; "min free" in the table is the actual headroom.
  console.log(
    'watch zram for GROWTH across a run; a steady figure means no pressure was reached. ' +
      'Read "min free" above as the real headroom.'
  );
}
