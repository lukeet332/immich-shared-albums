// verify/verify-interceptor.mjs — the app-facing byte interceptor, end to end across two servers.
//
//   node verify/verify-interceptor.mjs
//
// Two REAL sidecars: an ORIGIN that owns a photo, and a MEMBER whose library holds only a stub with
// a ledger row pointing at it. The member's `/api/assets/:id/thumbnail` is the URL Immich's own app
// requests, so this is the exact path a shared photo takes to a screen.
//
// What it proves that nothing else can:
//   - MISS  — the bytes came from the owner over iroh, and match the owner's own preview byte for byte
//   - HIT   — the second view skipped the cross-server fetch entirely
//   - and the cache is keyed by the ORIGIN asset, so it is the same entry every household would use
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// The shared JS oracle resolves its dependencies from ISA_ROOT (the probe container sets it to
// /app). A lane run from a checkout is the repo root, so default it here rather than making every
// caller remember an environment variable the lane can work out for itself.
process.env.ISA_ROOT ??= REPO;
const RUST = `${REPO}/rust`;
const require = createRequire(REPO + '/package.json');
// iroh-client.mjs resolves @number0/iroh through ISA_ROOT, and reads it at module load — so it must
// be set before the dynamic import, not after.
process.env.ISA_ROOT = REPO;
const { bindAs, request } = await import(REPO + '/demo/e2e/iroh-client.mjs');

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

const ORIGIN_PORT = 9420, ORIGIN_P2P = 9421, ORIGIN_DIR = '/tmp/isa-int-origin';
const MEMBER_PORT = 9422, MEMBER_P2P = 9423, MEMBER_DIR = '/tmp/isa-int-member';

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${d ? ` — ${d}` : ''}`); };
const sha1 = b => crypto.createHash('sha1').update(b).digest('hex');
const api = async (path, body, method = 'POST') => (await fetch(`${IMMICH}/api${path}`, {
  method, headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
})).json();

const procs = [];
const stop = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } } };
const waitFor = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
};
// ISA_RELAY=false, not 'off': the config parses strictly, and a typo must fail loudly at boot.
const env = (dataDir, port, p2p, extra = {}) => ({
  ...process.env, ISA_IMMICH_API_KEY: BKEY, ISA_IMMICH_URL: IMMICH, ISA_DATA_DIR: dataDir,
  ISA_HOUSEHOLD_NAME: 'Interceptor verify', ISA_PORT: String(port), ISA_P2P_PORT: String(p2p),
  ISA_RELAY: 'false', ISA_SYNC_POLL_MS: '1000', ...extra,
});

try {
  // ---- the ORIGIN: a real album with a real photo, seeded as an owner mapping ----
  const album = await api('/albums', { albumName: `interceptor verify ${Date.now()}` });
  const form = new FormData();
  form.append('assetData', new Blob([fs.readFileSync(`${REPO}/demo/e2e/fixtures/fx0.jpg`)], { type: 'image/jpeg' }), 'fx0.jpg');
  form.append('deviceAssetId', `int-${Date.now()}`);
  form.append('deviceId', 'interceptor-verify');
  form.append('fileCreatedAt', new Date().toISOString());
  form.append('fileModifiedAt', new Date().toISOString());
  const photo = await (await fetch(`${IMMICH}/api/assets`, { method: 'POST', headers: { 'x-api-key': BKEY }, body: form })).json();
  await fetch(`${IMMICH}/api/albums/${album.id}/assets`, {
    method: 'PUT', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [photo.id] }),
  });
  // exif takes a moment; the preview is not served until the owner's Immich has processed it.
  for (let i = 0; i < 40; i++) {
    const a = await (await fetch(`${IMMICH}/api/assets/${photo.id}`, { headers: { 'x-api-key': BKEY } })).json();
    if (a.exifInfo?.exifImageWidth) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const ownerPreview = Buffer.from(await (await fetch(`${IMMICH}/api/assets/${photo.id}/thumbnail?size=preview`, { headers: { 'x-api-key': BKEY } })).arrayBuffer());
  check('the owner has a real preview to serve', ownerPreview.length > 500, `${ownerPreview.length} bytes`);

  const link = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: true });

  // A fresh state dir is the whole origin fixture: it needs no local mapping to SERVE bytes, only
  // the enrolment and the offered list that the member's join below writes.
  fs.rmSync(ORIGIN_DIR, { recursive: true, force: true });
  fs.mkdirSync(ORIGIN_DIR, { recursive: true });
  procs.push(spawn(`${RUST}/target/debug/isa`, [], { env: env(ORIGIN_DIR, ORIGIN_PORT, ORIGIN_P2P), stdio: 'ignore' }));
  check('the origin sidecar answers', await waitFor(`http://127.0.0.1:${ORIGIN_PORT}/immich-shared-albums/health`));

  const page = await (await fetch(`http://127.0.0.1:${ORIGIN_PORT}/share/${link.key}`)).text();
  const target = JSON.parse(Buffer.from(page.match(/data-origin-endpoint="([^"]+)"/)[1], 'base64url').toString());
  target.addrs = [`127.0.0.1:${ORIGIN_P2P}`, ...(target.addrs || [])];

  // ---- the MEMBER joins with a keypair, so the origin enrols THAT identity ----
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const memberKeys = {
    priv: privateKey.export({ format: 'jwk' }).d,
    pub: publicKey.export({ format: 'jwk' }).x,
  };
  process.env.RELAY = 'off';
  const memberEp = await bindAs(memberKeys);
  const redeemed = await request(memberEp, target.pub, target.addrs, '/invites/redeem', {
    body: { shareKey: link.key, household: { name: 'Member household' }, protocol: 2, version: '1.1.1' },
  });
  check('the member joins and is offered the album', redeemed.status === 200, `status=${redeemed.status}`);
  check('the origin offers it the photo', redeemed.json?.manifest?.some(r => r.originAsset === photo.id));

  // ---- the MEMBER sidecar: a stub in its own library, and the ledger row that makes it a PROXY ----
  fs.rmSync(MEMBER_DIR, { recursive: true, force: true });
  const seededOut = execFileSync(`${RUST}/target/debug/examples/seed_proxy`, [photo.id], {
    env: env(MEMBER_DIR, MEMBER_PORT, MEMBER_P2P, {
      PEER_PUB: target.pub,
      PEER_ADDR: `127.0.0.1:${ORIGIN_P2P}`,
      REMOTE_ALBUM_ID: album.id,
      IDENTITY_PUB: memberKeys.pub,
      IDENTITY_PRIV: memberKeys.priv,
    }),
    encoding: 'utf8',
  });
  const seeded = JSON.parse(seededOut.trim().split('\n').pop());
  procs.push(spawn(`${RUST}/target/debug/isa`, [], { env: env(MEMBER_DIR, MEMBER_PORT, MEMBER_P2P), stdio: 'ignore' }));
  check('the member sidecar answers', await waitFor(`http://127.0.0.1:${MEMBER_PORT}/immich-shared-albums/health`));

  // ---- the app-facing URL, exactly as Immich's own app requests it ----
  const thumbUrl = `http://127.0.0.1:${MEMBER_PORT}/api/assets/${seeded.assetId}/thumbnail?size=preview`;
  const first = await fetch(thumbUrl, { headers: { 'x-api-key': BKEY } });
  const firstBytes = Buffer.from(await first.arrayBuffer());
  check('the thumbnail is served', first.status === 200, `status=${first.status}`);
  check('it came from the OWNER, not the stub', first.headers.get('x-cache') === 'MISS', `x-cache=${first.headers.get('x-cache')}`);
  check('and the bytes are the owner\'s, byte for byte', sha1(firstBytes) === sha1(ownerPreview),
    `member=${sha1(firstBytes).slice(0, 12)} owner=${sha1(ownerPreview).slice(0, 12)} (${firstBytes.length} vs ${ownerPreview.length} bytes)`);

  // ---- the second view must not cross the network at all ----
  const second = await fetch(thumbUrl, { headers: { 'x-api-key': BKEY } });
  const secondBytes = Buffer.from(await second.arrayBuffer());
  check('a repeat view is a cache HIT', second.headers.get('x-cache') === 'HIT', `x-cache=${second.headers.get('x-cache')}`);
  check('and a HIT is the same bytes', sha1(secondBytes) === sha1(ownerPreview));
} catch (e) {
  check('the run completed', false, e.message);
} finally {
  stop();
}

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
