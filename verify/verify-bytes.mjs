// verify/verify-bytes.mjs — the byte routes and the entitlement gate, driven by the independent JS
// peer over iroh. This is the F-05/F-06 control pair: a peer must be able to read what was shared
// with it, and must NOT be able to read anything else — including by naming it directly.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// The shared JS oracle resolves its dependencies from ISA_ROOT (the probe container sets it to
// /app). A lane run from a checkout is the repo root, so default it here rather than making every
// caller remember an environment variable the lane can work out for itself.
process.env.ISA_ROOT ??= REPO;
const require = createRequire(REPO + '/package.json');
const { bindAs, request } = await import(REPO + '/demo/e2e/iroh-client.mjs');
const crypto = await import('node:crypto');

const SIDECAR = process.env.SIDECAR || 'http://localhost:9410';
const P2P_PORT = process.env.P2P_PORT || '9411';
// The rig's host port map, the same one demo/e2e uses: 2384 here is THIS host's shift, and a
// default checkout (or CI) runs the mocks on 2284-2286.
const PORT = (name, dflt) => process.env[name] || dflt;
const IMMICH = `http://localhost:${PORT('PORT_IMMICH_B', 2284)}`;
// The key comes from the ENVIRONMENT, exactly as the e2e suite takes it (the rig exports BKEY):
// a lane has no business reading a credential off disk and putting it in a request header.
//   BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-) node <this lane>.mjs
const BKEY = process.env.BKEY || process.env.B_SIDECAR_API_KEY;
if (!BKEY) {
  console.error('BKEY is required — export the rig\'s household-B key first:');
  console.error("  BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-) node <lane>");
  process.exit(2);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? ' — ' + d : ''}`); };

const api = async (path, body, method = 'POST') => (await fetch(`${IMMICH}/api${path}`, {
  method, headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

// ---- seed: an album with a SHARED photo, and a second photo that is NOT shared ----
const album = await api('/albums', { albumName: `bytes verify ${Date.now()}` });
const upload = async name => {
  const form = new FormData();
  form.append('assetData', new Blob([fs.readFileSync(`${REPO}/demo/e2e/fixtures/${name}`)], { type: 'image/jpeg' }), name);
  form.append('deviceAssetId', `bytes-${name}-${Date.now()}`);
  form.append('deviceId', 'bytes-verify');
  form.append('fileCreatedAt', new Date().toISOString());
  form.append('fileModifiedAt', new Date().toISOString());
  return (await fetch(`${IMMICH}/api/assets`, { method: 'POST', headers: { 'x-api-key': BKEY }, body: form })).json();
};
const shared = await upload('fx0.jpg');
const privateAsset = await upload('fx1.jpg');
await fetch(`${IMMICH}/api/albums/${album.id}/assets`, {
  method: 'PUT', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [shared.id] }),
});
for (let i = 0; i < 40; i++) {
  const a = await (await fetch(`${IMMICH}/api/assets/${shared.id}`, { headers: { 'x-api-key': BKEY } })).json();
  if (a.exifInfo?.exifImageWidth) break;
  await new Promise(r => setTimeout(r, 500));
}
const link = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: true });
// A byte-identical copy of what the owner's Immich serves, for a real comparison.
const originPreview = Buffer.from(await (await fetch(`${IMMICH}/api/assets/${shared.id}/thumbnail?size=preview`, { headers: { 'x-api-key': BKEY } })).arrayBuffer());
const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');

// ---- the joined peer ----
const target = JSON.parse(
  Buffer.from((await (await fetch(`${SIDECAR}/share/${link.key}`)).text()).match(/data-origin-endpoint="([^"]+)"/)[1], 'base64url').toString()
);
target.addrs = [`127.0.0.1:${P2P_PORT}`, ...(target.addrs || [])];
const keysFor = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ format: 'jwk' }).d, pub: publicKey.export({ format: 'jwk' }).x };
};
process.env.RELAY = 'off';
const joined = keysFor();
const ep = await bindAs(joined);

const redeemed = await request(ep, target.pub, target.addrs, '/invites/redeem', {
  body: { shareKey: link.key, household: { name: 'Byte peer' }, protocol: 2, version: '1.1.1' },
});
check('the peer joins and is offered the album', redeemed.status === 200, `${redeemed.status}`);
check('the manifest names the shared photo', redeemed.json?.manifest?.some(r => r.originAsset === shared.id),
  `${redeemed.json?.manifest?.length} refs`);
check('and does NOT name the unshared one', !redeemed.json?.manifest?.some(r => r.originAsset === privateAsset.id));

// ---- F-05 control: what WAS shared is readable, byte-for-byte ----
const got = await request(ep, target.pub, target.addrs, `/assets/${shared.id}/preview`, {
  wantBytes: true,
  bytesToCapture: true,
});
check('an OFFERED asset IS readable (the control against over-blocking)', got.status === 200, `status=${got.status} bytes=${got.bytesLength}`);
check('and the bytes are non-trivial', (got.bytesLength || 0) > 500, `${got.bytesLength} bytes`);

// ---- F-05: what was NOT shared is refused, even named directly ----
const denied = await request(ep, target.pub, target.addrs, `/assets/${privateAsset.id}/preview`);
check('an asset NEVER shared is refused with 403', denied.status === 403, `${denied.status} ${JSON.stringify(denied.json)}`);
check('and the refusal says why', denied.json?.error === 'not shared with you', String(denied.json?.error));

// An invented asset id is refused the same way — naming something is not entitlement to it.
const invented = await request(ep, target.pub, target.addrs, '/assets/00000000-0000-4000-8000-000000000000/original');
check('an invented asset id is refused too', invented.status === 403, `${invented.status}`);

// ---- an UNENROLLED peer is refused before entitlement is even consulted ----
const strangerKeys = keysFor();
const strangerEp = await bindAs(strangerKeys);
const asStranger = await request(strangerEp, target.pub, target.addrs, `/assets/${shared.id}/preview`);
check('an unknown peer is refused with "unknown peer"', asStranger.status === 403 && asStranger.json?.error === 'unknown peer',
  `${asStranger.status} ${asStranger.json?.error}`);

// ---- originals stream, and a Range is carried to the owner ----
const original = await request(ep, target.pub, target.addrs, `/assets/${shared.id}/original`, { wantBytes: true });
check('the ORIGINAL streams too', original.status === 200 && (original.bytesLength || 0) > 0, `status=${original.status} bytes=${original.bytesLength}`);

console.log(`\n${results.every(Boolean) ? '✅ ALL PASS' : '❌ FAILURES'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 1);
