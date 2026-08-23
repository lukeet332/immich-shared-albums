// e2e/iroh-client.mjs — a minimal iroh peer client for the assertion suite. Speaks the isa/2
// framing from src/p2p/transport.ts so security checks (F-05/F-06) stay real wire tests.
import { createRequire } from 'node:module';
const require = createRequire(process.env.ISA_ROOT + '/package.json');
const { Endpoint, EndpointAddr, EndpointId, RelayMode, presetMinimal } = require('@number0/iroh');

const ALPN = Array.from(Buffer.from('isa/2'));
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const pubToRaw = pubB64 => Array.from(Buffer.from(pubB64, 'base64url').subarray(SPKI.length));
const seedFromPkcs8 = privB64 => {
  const { createPrivateKey } = require('node:crypto');
  const jwk = createPrivateKey({ key: Buffer.from(privB64, 'base64url'), format: 'der', type: 'pkcs8' }).export({
    format: 'jwk',
  });
  return Array.from(Buffer.from(jwk.d, 'base64url'));
};

const framed = payload => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(payload.length);
  return Array.from(Buffer.concat([len, payload]));
};
const readFramed = async recv => {
  const len = Buffer.from(await recv.readExact(4)).readUInt32LE();
  return len === 0 ? Buffer.alloc(0) : Buffer.from(await recv.readExact(len));
};

/** Bind an endpoint from a household's stored keypair ({pub, priv} base64url DER). */
export async function bindAs(keys) {
  const b = Endpoint.builder();
  presetMinimal(b);
  if (process.env.RELAY !== 'off') b.relayMode(RelayMode.defaultMode());
  b.alpns([ALPN]);
  b.secretKey(seedFromPkcs8(keys.priv));
  return b.bind();
}

/** One request against a peer endpoint (its pub key + direct addrs). Returns {status, json, bytesLength}. */
export async function request(ep, peerPub, peerAddrs, path, { body, range, wantBytes } = {}) {
  const addr = new EndpointAddr(EndpointId.fromBytes(pubToRaw(peerPub)), null, peerAddrs);
  const conn = await ep.connect(addr, ALPN);
  const bi = await conn.openBi();
  await bi.send.writeAll(framed(Buffer.from(JSON.stringify({ path, range }))));
  await bi.send.writeAll(framed(body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)));
  await bi.send.finish();
  const head = JSON.parse((await readFramed(bi.recv)).toString());
  let bytesLength = 0;
  if (wantBytes) {
    for (;;) {
      const c = await bi.recv.read(262144);
      if (!c || c.length === 0) break;
      bytesLength += c.length;
    }
    conn.close(0n, []);
    return { status: head.status, bytesLength };
  }
  const rest = Buffer.from(await bi.recv.readToEnd(64 * 1024 * 1024));
  conn.close(0n, []);
  return { status: head.status, json: rest.length ? JSON.parse(rest.toString()) : null };
}
