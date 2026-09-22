// rust/peer-interop.mjs — dial the RUST iroh endpoint from the INDEPENDENT JavaScript peer used by
// the e2e suite (demo/e2e/iroh-client.mjs). Two real endpoints, two implementations, one wire.
//
// Run:
//   cd rust && cargo build --example peer_server
//   ISA_IMMICH_API_KEY=test ISA_DATA_DIR=/tmp/isa-peer ISA_P2P_PORT=9711 ./target/debug/examples/peer_server > /tmp/peer.json &
//   node peer-interop.mjs /tmp/peer.json
import { createRequire } from 'node:module';
import fs from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(REPO + '/package.json');
// The oracle itself, unmodified: the same module the e2e suite uses for F-05/F-06.
const { bindAs, request } = await import(REPO + '/demo/e2e/iroh-client.mjs');

const target = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/peer.json', 'utf8'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// A throwaway identity for the JS side, generated here rather than borrowed.
const crypto = await import('node:crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const keys = {
  priv: privateKey.export({ format: 'jwk' }).d,
  pub: publicKey.export({ format: 'jwk' }).x,
};

// RELAY=off so this is a DIRECT dial on loopback — no third party in the path.
process.env.RELAY = 'off';
const ep = await bindAs(keys);
check('the JS oracle bound its own iroh endpoint', !!ep);

// ---- /hello: the handshake both sides must agree on ----
const hello = await request(ep, target.pub, target.addrs, '/hello');
check('a JS peer DIALS the Rust endpoint over iroh', hello.status === 200, JSON.stringify(hello).slice(0, 90));
check('the Rust side answers the protocol handshake', hello.json?.protocol === 2, `protocol=${hello.json?.protocol}`);
check(
  'and advertises the feature list unchanged',
  JSON.stringify(hello.json?.features) === '["sync-status"]',
  JSON.stringify(hello.json?.features)
);
check(
  'the Rust side sees the JS peer\'s REAL identity from the connection',
  hello.json?.you_are === keys.pub,
  `${String(hello.json?.you_are).slice(0, 12)}… vs ${keys.pub.slice(0, 12)}…`
);

// ---- framing in both directions, including a Range and a body ----
const echoed = await request(ep, target.pub, target.addrs, '/echo', {
  range: 'bytes=0-2097151',
  body: { add: ['a1', 'a2'] },
});
check('a second request on a fresh connection succeeds', echoed.status === 200);
check('the Range crossed verbatim', echoed.json?.range === 'bytes=0-2097151', String(echoed.json?.range));
const sentBody = JSON.stringify({ add: ['a1', 'a2'] });
check(
  'the JSON body crossed intact, byte for byte',
  echoed.json?.body === sentBody && echoed.json?.body_len === Buffer.byteLength(sentBody),
  `${echoed.json?.body_len} bytes (sent ${Buffer.byteLength(sentBody)}): ${echoed.json?.body}`
);

// ---- an unknown route is a clean 404, not a dropped connection ----
const missing = await request(ep, target.pub, target.addrs, '/nope');
check('an unknown route answers 404 rather than hanging', missing.status === 404, `status=${missing.status}`);

console.log(
  `\n${results.every(r => r.ok) ? '✅ THE RUST ENDPOINT SERVES A REAL JS PEER' : '❌ INTEROP FAILURE'} (${results.filter(r => r.ok).length}/${results.length})`
);
process.exit(results.every(r => r.ok) ? 0 : 1);
