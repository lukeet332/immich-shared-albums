// rust/verify-redeem.mjs — a JS peer redeems a share link against the Rust sidecar, over iroh.
// This is the enrolment path join.ts drives, including every gate that can refuse it.
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
//   BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-) node rust/<this lane>.mjs
const BKEY = process.env.BKEY || process.env.B_SIDECAR_API_KEY;
if (!BKEY) {
  console.error('BKEY is required — export the rig\'s household-B key first:');
  console.error("  BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-) node rust/<lane>");
  process.exit(2);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? ' — ' + d : ''}`); };

// ---- seed albums and links on the mock ----
const api = async (path, body) => (await fetch(`${IMMICH}/api${path}`, {
  method: 'POST', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})).json();

const album = await api('/albums', { albumName: `redeem verify ${Date.now()}` });

// Seed a REAL photo, so the manifest has substance rather than being an empty array that passes.
const photo = fs.readFileSync(REPO + '/demo/e2e/fixtures/fx0.jpg');
const form = new FormData();
form.append('assetData', new Blob([photo], { type: 'image/jpeg' }), 'fx0.jpg');
form.append('deviceAssetId', `redeem-verify-${Date.now()}`);
form.append('deviceId', 'redeem-verify');
form.append('fileCreatedAt', new Date().toISOString());
form.append('fileModifiedAt', new Date().toISOString());
const uploaded = await (await fetch(`${IMMICH}/api/assets`, {
  method: 'POST', headers: { 'x-api-key': BKEY }, body: form,
})).json();
// Immich adds assets to an album with PUT, not POST.
await fetch(`${IMMICH}/api/albums/${album.id}/assets`, {
  method: 'PUT', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: [uploaded.id] }),
});
// Confirm the photo really is in the album before asserting on a manifest built from it.
const inAlbum = await (await fetch(`${IMMICH}/api/albums/${album.id}`, { headers: { 'x-api-key': BKEY } })).json();
if ((inAlbum.assetCount || 0) < 1) throw new Error('the seeded photo did not land in the album');
// Immich measures dimensions asynchronously; wait for the shape the manifest needs.
for (let i = 0; i < 30; i++) {
  const a = await (await fetch(`${IMMICH}/api/assets/${uploaded.id}`, { headers: { 'x-api-key': BKEY } })).json();
  if (a.exifInfo?.exifImageWidth) break;
  await new Promise(r => setTimeout(r, 500));
}
const openLink = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: true });
const pwLink = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: false, password: 'opensesame' });

// ---- the sidecar's own identity + address, so the peer knows who to dial ----
const peersRes = await fetch(`${SIDECAR}/immich-shared-albums/health`);
check('the sidecar is up', peersRes.status === 200);

// Mint a pairing link to learn the address... simpler: read it from the share page's token.
const sharePage = await (await fetch(`${SIDECAR}/share/${openLink.key}`)).text();
const token = sharePage.match(/data-origin-endpoint="([^"]+)"/)?.[1];
const target = JSON.parse(Buffer.from(token, 'base64url').toString());
target.addrs = [`127.0.0.1:${P2P_PORT}`, ...(target.addrs || [])];
check('read the sidecar address from its own share page', !!target.pub, `${target.pub.slice(0, 12)}…`);

// ---- the dialling peer ----
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const myKeys = { priv: privateKey.export({ format: 'jwk' }).d, pub: publicKey.export({ format: 'jwk' }).x };
process.env.RELAY = 'off';
const ep = await bindAs(myKeys);

const redeem = async (body) => request(ep, target.pub, target.addrs, '/invites/redeem', { body });
const household = { name: 'Joiner household' };

// ---- the happy path ----
const good = await redeem({ shareKey: openLink.key, household, protocol: 2, version: '1.1.1' });
check('a peer redeems a share link', good.status === 200, `${good.status} ${JSON.stringify(good.json).slice(0, 90)}`);
check('it names the album', good.json?.album?.name?.startsWith('redeem verify'), good.json?.album?.name);
check('a contribute link grants contribute', good.json?.album?.permissions === 'contribute', good.json?.album?.permissions);
check('it names the album owner', !!good.json?.albumOwner?.displayName, JSON.stringify(good.json?.albumOwner));
check('it returns a manifest with the seeded photo', (good.json?.manifest?.length || 0) >= 1, `${good.json?.manifest?.length} refs`);
const ref = good.json?.manifest?.[0];
check('the ref names the ORIGIN asset', ref?.originAsset === uploaded.id, `${ref?.originAsset} vs ${uploaded.id}`);
check('the ref carries a checksum', typeof ref?.checksum === 'string' && ref.checksum.length > 0, ref?.checksum?.slice(0, 16));
check('the ref carries a kind', ref?.kind === 'image', ref?.kind);
check('the ref names a contributor with an origin user id',
  !!ref?.contributor?.displayName && !!ref?.contributor?.originUserId,
  JSON.stringify(ref?.contributor));
check('the ref carries REAL dimensions, not 1x1',
  (ref?.exif?.width || 0) > 1 && (ref?.exif?.height || 0) > 1,
  `${ref?.exif?.width}x${ref?.exif?.height}`);
check('the ref carries a capture time', typeof ref?.takenAt === 'string', ref?.takenAt);
check('it returns a mappingId', typeof good.json?.mappingId === 'string' && good.json.mappingId.length === 36, good.json?.mappingId);
check('and the handshake fields', good.json?.protocol === 2 && !!good.json?.version);

// A view-only link must say so — Immich itself then refuses a local add.
const view = await redeem({ shareKey: pwLink.key, household, protocol: 2, version: '1.1.1', password: 'opensesame' });
check('a view-only link grants view', view.json?.album?.permissions === 'view', view.json?.album?.permissions);

// ---- IDEMPOTENCE: the same link again reuses the mapping ----
const again = await redeem({ shareKey: openLink.key, household, protocol: 2, version: '1.1.1' });
// Guard against the false positive where BOTH sides are undefined.
check(
  're-redeeming the SAME link reuses the mapping',
  !!good.json?.mappingId && again.json?.mappingId === good.json?.mappingId,
  `${good.json?.mappingId} vs ${again.json?.mappingId}`
);

// ---- the gates ----
const unknown = await redeem({ shareKey: 'no-such-key', household, protocol: 2 });
check('an unknown share key is 404 with its code', unknown.status === 404 && unknown.json?.code === 'unknown_share_key',
  `${unknown.status} ${unknown.json?.code}`);

const noPassword = await redeem({ shareKey: pwLink.key, household, protocol: 2 });
check('a password-protected link without a password is 401 password_required',
  noPassword.status === 401 && noPassword.json?.code === 'password_required' && noPassword.json?.passwordRequired === true,
  `${noPassword.status} ${noPassword.json?.code}`);

const wrongPassword = await redeem({ shareKey: pwLink.key, household, protocol: 2, password: 'guess' });
check('a wrong password is 403 wrong_password',
  wrongPassword.status === 403 && wrongPassword.json?.code === 'wrong_password',
  `${wrongPassword.status} ${wrongPassword.json?.code}`);

const malformed = await redeem({ shareKey: openLink.key, protocol: 2 });
check('a body with no household is 400 malformed', malformed.status === 400, `${malformed.status} ${malformed.json?.error}`);

// ---- the setting must REFUSE, not merely hide the card ----
const session = (await (await fetch(`${IMMICH}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@e2e.local', password: 'e2e-admin-pass-1' }),
})).headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).find(c => c.includes('access_token'));

const off = await fetch(`${SIDECAR}/immich-shared-albums/settings`, {
  method: 'POST', headers: { cookie: session, 'Content-Type': 'application/json' },
  body: JSON.stringify({ shareLinkJoin: false }),
});
check('the panel can turn share-link joining OFF', off.status === 200, `${off.status}`);

const refused = await redeem({ shareKey: openLink.key, household, protocol: 2 });
check('and the PEER route then refuses with 403 — the setting does not merely hide a card',
  refused.status === 403 && /does not accept album joins/i.test(refused.json?.error || ''),
  `${refused.status} ${refused.json?.error}`);

const sharePageOff = await (await fetch(`${SIDECAR}/share/${openLink.key}`)).text();
check('while the share page itself falls through to Immich', !sharePageOff.includes('data-origin-endpoint'));

// Restore, so the next run starts clean.
await fetch(`${SIDECAR}/immich-shared-albums/settings`, {
  method: 'POST', headers: { cookie: session, 'Content-Type': 'application/json' },
  body: JSON.stringify({ shareLinkJoin: true }),
});
const restored = await redeem({ shareKey: openLink.key, household, protocol: 2 });
check('turning it back on accepts joins again', restored.status === 200, `${restored.status}`);

console.log(`\n${results.every(Boolean) ? '✅ ALL PASS' : '❌ FAILURES'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 1);
