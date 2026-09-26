// rust/jpeg-parity.mjs — the Rust stub JPEG must be BYTE-IDENTICAL to the TypeScript one.
//
// Parity is the contract, not a nicety: Immich lays every shared photo out from the stub's
// declared dimensions, so a stub that differs in size or ratio shows up as a wrong-shaped tile in
// someone's library. This compares the two implementations byte for byte.
//
//   cd rust && cargo build --example jpeg_dump
//   node jpeg-parity.mjs
import { execFileSync } from 'node:child_process';

const RUST = execFileSync('./target/debug/examples/jpeg_dump', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .trim().split('\n');

const { jpegOfSize } = await import('../src/media/jpeg.ts');

let failures = 0;
for (const line of RUST) {
  const [size, len, hex] = line.split(' ');
  const [w, h] = size.split('x').map(Number);
  const theirs = jpegOfSize(w, h).toString('hex');
  const same = theirs === hex;
  if (!same) failures++;
  console.log(
    `${same ? '  ✅' : '  ❌'} ${size.padEnd(11)} rust=${String(len).padStart(4)}B ts=${String(theirs.length / 2).padStart(4)}B` +
      (same ? '' : `  FIRST DIFF AT ${firstDiff(theirs, hex)}`)
  );
}
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `byte ${Math.floor(i / 2)}`;
  return 'none';
}
console.log(`\n${failures === 0 ? '✅ BYTE-IDENTICAL' : `❌ ${failures} DIFFER`} (${RUST.length - failures}/${RUST.length})`);
process.exit(failures === 0 ? 0 : 1);
