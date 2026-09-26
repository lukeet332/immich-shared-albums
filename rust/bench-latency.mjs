// bench-latency.mjs — server latency with a KEEP-ALIVE client, so what is measured is the sidecar
// and not the cost of spawning a `curl` process per request.
//
//   node rust/bench-latency.mjs <nodePort> <rustPort>
//
// Reports mean/p50/p95 per endpoint and concurrent throughput. Both sidecars are driven identically:
// same endpoints, same request count, same warm-up, same single connection pool.
import fs from 'node:fs';

const NODE_PORT = Number(process.argv[2] || 8395);
const RUST_PORT = Number(process.argv[3] || 8396);
const N = Number(process.env.N || 2000);
const NAMES = ['Node/TypeScript', 'Rust'];

const paths = [
  ['/immich-shared-albums/health', 'health (no Immich)'],
  ['/immich-shared-albums/assets/panel.js', 'static bundle (embedded)'],
  ['/auth/login', 'passthrough -> Immich'],
];

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

async function measure(port, path) {
  // Warm-up first: connection setup and TLS-ish handshakes must not be inside the sample.
  for (let i = 0; i < 50; i++) await fetch(`http://127.0.0.1:${port}${path}`).then(r => r.arrayBuffer());
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    await res.arrayBuffer();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { mean: times.reduce((a, b) => a + b, 0) / times.length, p50: pct(times, 0.5), p95: pct(times, 0.95) };
}

// Concurrent throughput: 50 in flight, sustained, so per-request loop overhead is amortised.
async function throughput(port, path, concurrency = 50, total = 2000) {
  const t0 = process.hrtime.bigint();
  let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (done < total) {
      done++;
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      await res.arrayBuffer();
    }
  }));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  return total / secs;
}

const results = {};
for (const [port, name] of [[NODE_PORT, NAMES[0]], [RUST_PORT, NAMES[1]]]) {
  results[name] = {};
  for (const [path, label] of paths) results[name][label] = await measure(port, path);
  results[name]['throughput health rps'] = await throughput(port, '/immich-shared-albums/health');
  results[name]['throughput passthrough rps'] = await throughput(port, '/auth/login');
}

const fmt = n => n.toFixed(2);
console.log(`\n${N} sequential requests + 2000 concurrent (50 in flight) per endpoint\n`);
console.log('endpoint'.padEnd(28), 'Node mean/p50/p95 ms'.padEnd(24), 'Rust mean/p50/p95 ms'.padEnd(24), 'speedup');
for (const [, label] of paths) {
  const a = results[NAMES[0]][label], b = results[NAMES[1]][label];
  console.log(
    label.padEnd(28),
    `${fmt(a.mean)} / ${fmt(a.p50)} / ${fmt(a.p95)}`.padEnd(24),
    `${fmt(b.mean)} / ${fmt(b.p50)} / ${fmt(b.p95)}`.padEnd(24),
    `${(a.mean / b.mean).toFixed(2)}x`
  );
}
for (const key of ['throughput health rps', 'throughput passthrough rps']) {
  const a = results[NAMES[0]][key], b = results[NAMES[1]][key];
  console.log(key.padEnd(28), `${a.toFixed(0)} rps`.padEnd(24), `${b.toFixed(0)} rps`.padEnd(24), `${(b / a).toFixed(2)}x`);
}
// Build output, not the shared temporary directory: a fixed, predictable path inside the checkout,
// next to the target/ dir it belongs with (gitignored), so two runs cannot collide or be squatted.
const outDir = new URL('./target/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });
const outPath = new URL('./target/bench-latency.json', import.meta.url);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log('results written to', outPath.pathname);
