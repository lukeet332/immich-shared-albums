// verify/verify-sync.mjs — the pull side of sync: a peer reads an album's version, manifest and
// status over iroh, and a withdrawal answers 410 so the receiver stops retrying.
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

const api = async (path, body) => (await fetch(`${IMMICH}/api${path}`, {
  method: 'POST', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

// ---- seed an album with a photo ----
const album = await api('/albums', { albumName: `sync verify ${Date.now()}` });
const form = new FormData();
form.append('assetData', new Blob([fs.readFileSync(`${REPO}/demo/e2e/fixtures/fx2.jpg`)], { type: 'image/jpeg' }), 'fx2.jpg');
form.append('deviceAssetId', `sync-verify-${Date.now()}`);
form.append('deviceId', 'sync-verify');
form.append('fileCreatedAt', new Date().toISOString());
form.append('fileModifiedAt', new Date().toISOString());
const asset = await (await fetch(`${IMMICH}/api/assets`, { method: 'POST', headers: { 'x-api-key': BKEY }, body: form })).json();
await fetch(`${IMMICH}/api/albums/${album.id}/assets`, {
  method: 'PUT', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [asset.id] }),
});
for (let i = 0; i < 40; i++) {
  const a = await (await fetch(`${IMMICH}/api/assets/${asset.id}`, { headers: { 'x-api-key': BKEY } })).json();
  if (a.exifInfo?.exifImageWidth) break;
  await new Promise(r => setTimeout(r, 500));
}
const link = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: true });

// ---- join ----
const target = JSON.parse(
  Buffer.from((await (await fetch(`${SIDECAR}/share/${link.key}`)).text()).match(/data-origin-endpoint="([^"]+)"/)[1], 'base64url').toString()
);
target.addrs = [`127.0.0.1:${P2P_PORT}`, ...(target.addrs || [])];
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
process.env.RELAY = 'off';
const ep = await bindAs({ priv: privateKey.export({ format: 'jwk' }).d, pub: publicKey.export({ format: 'jwk' }).x });
const joined = await request(ep, target.pub, target.addrs, '/invites/redeem', {
  body: { shareKey: link.key, household: { name: 'Sync peer' }, protocol: 2, version: '1.1.1' },
});
const mappingId = joined.json?.mappingId;
check('the peer joins and gets a mapping', joined.status === 200 && !!mappingId, `${joined.status}`);

// ---- /version: one cheap read instead of a manifest scan ----
const version = await request(ep, target.pub, target.addrs, `/albums/${mappingId}/version`);
check('/version answers', version.status === 200, `${version.status} ${JSON.stringify(version.json).slice(0, 80)}`);
check('it carries an updatedAt', typeof version.json?.updatedAt === 'string' && version.json.updatedAt.length > 0, version.json?.updatedAt);
check('it carries an assetCount of 1', version.json?.assetCount === 1, String(version.json?.assetCount));
check('the packed version token matches the structured fields',
  version.json?.version === `${version.json?.updatedAt}|${version.json?.assetCount}`,
  version.json?.version);

// ---- /manifest: the refs, with entitlement recorded before answering ----
const manifest = await request(ep, target.pub, target.addrs, `/albums/${mappingId}/manifest`);
check('/manifest answers', manifest.status === 200, `${manifest.status}`);
check('and names the seeded photo', manifest.json?.manifest?.some(r => r.originAsset === asset.id), `${manifest.json?.manifest?.length} refs`);

// A manifest pull is itself an offer: the peer must now be able to READ what it was just given.
const bytes = await request(ep, target.pub, target.addrs, `/assets/${asset.id}/preview`, { wantBytes: true });
check('a manifest pull records entitlement, so the bytes are then readable',
  bytes.status === 200 && (bytes.bytesLength || 0) > 0, `${bytes.status} ${bytes.bytesLength} bytes`);

// ---- /status ----
const status = await request(ep, target.pub, target.addrs, `/albums/${mappingId}/status`);
check('/status answers with the documented shape', status.status === 200, `${status.status}`);
check('it reports settled/pending/cycles/failCount/dead',
  typeof status.json?.settled === 'boolean' && status.json?.pending === 0 &&
  typeof status.json?.cycles === 'number' && typeof status.json?.failCount === 'number' &&
  typeof status.json?.dead === 'boolean',
  JSON.stringify(status.json));

// ---- the gates ----
const unknownMapping = await request(ep, target.pub, target.addrs, '/albums/no-such-mapping/version');
check('an unknown mapping is 404 unknown_mapping',
  unknownMapping.status === 404 && unknownMapping.json?.code === 'unknown_mapping',
  `${unknownMapping.status} ${unknownMapping.json?.code}`);

const strangerKeys = crypto.generateKeyPairSync('ed25519');
const strangerEp = await bindAs({
  priv: strangerKeys.privateKey.export({ format: 'jwk' }).d,
  pub: strangerKeys.publicKey.export({ format: 'jwk' }).x,
});
const asStranger = await request(strangerEp, target.pub, target.addrs, `/albums/${mappingId}/version`);
check('an unknown peer cannot read a version', asStranger.status === 403 && asStranger.json?.code === 'unknown_peer',
  `${asStranger.status} ${asStranger.json?.code}`);

// ---- withdrawal must answer 410, not 404, so a receiver stops retrying ----
const left = await request(ep, target.pub, target.addrs, `/albums/${mappingId}/leave`);
check('/leave answers ok', left.status === 200 && left.json?.ok === true, `${left.status}`);

const afterLeave = await request(ep, target.pub, target.addrs, `/albums/${mappingId}/version`);
check('after a leave, /version answers 410 GONE rather than 404',
  afterLeave.status === 410 && afterLeave.json?.code === 'gone',
  `${afterLeave.status} ${afterLeave.json?.code}`);

const manifestAfter = await request(ep, target.pub, target.addrs, `/albums/${mappingId}/manifest`);
check('and so does /manifest — the relationship is over, not mis-addressed', manifestAfter.status === 410, `${manifestAfter.status}`);

// Revocation is real: the entitlement rows went with the mapping.
const bytesAfter = await request(ep, target.pub, target.addrs, `/assets/${asset.id}/preview`);
check('and the bytes are refused afterwards (revocation is real)', bytesAfter.status === 403, `${bytesAfter.status} ${bytesAfter.json?.error}`);

console.log(`\n${results.every(Boolean) ? '✅ ALL PASS' : '❌ FAILURES'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 1);
