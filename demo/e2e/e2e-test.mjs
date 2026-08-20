// Full-cycle E2E assertion harness: reseed A, reset B, join, contribute, verify.
// Usage: node e2e-test.mjs  (env: AKEY, BKEY, A_URL, B_URL, B_SIDECAR)
const A = process.env.A_URL || 'http://localhost:2285';
const B = process.env.B_URL || 'http://localhost:2284';
const BS = process.env.B_SIDECAR || 'http://localhost:8301';
const AKEY = process.env.AKEY, BKEY = process.env.BKEY;
const ALBUM = process.env.A_ALBUM || '__CREATE__';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`); };
const api = async (base, key, path, init = {}) => {
  const r = await fetch(`${base}/api${path}`, { ...init, headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.status === 204 ? null : r.json();
};
const j = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
// /immich-shared-albums/join authenticates the caller against that household's own Immich, so the
// suite has to present a real credential exactly like a signed-in browser would.
const jAuth = (o, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(o) });
const albumAssets = async (base, key, albumId) =>
  (await api(base, key, '/search/metadata', j({ albumIds: [albumId], size: 100, withExif: true }))).assets.items;
import crypto from 'node:crypto';
import fs from 'node:fs';
// visually-unique local fixtures: distinct pixels => distinct previews (no dedup collapse)
let FX = 0;
const upload = async (base, key, name, seed, takenAt) => {
  const bytes = Buffer.concat([fs.readFileSync(new URL(`./fixtures/fx${FX++ % 12}.jpg`, import.meta.url)), crypto.randomBytes(8)]);
  const fd = new FormData();
  fd.set('deviceAssetId', `e2e-${seed}`); fd.set('deviceId', 'e2e-test');
  fd.set('fileCreatedAt', takenAt); fd.set('fileModifiedAt', takenAt);
  fd.set('assetData', new Blob([bytes], { type: 'image/jpeg' }), name);
  const r = await fetch(`${base}/api/assets`, { method: 'POST', headers: { 'x-api-key': key }, body: fd });
  const out = await r.json();
  if (!out.id) throw new Error(`upload failed: ${JSON.stringify(out).slice(0,120)}`);
  return out.id;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ensurePreviews = async (base, key, ids) => {
  for (const id of ids) {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${base}/api/assets/${id}/thumbnail?size=preview`, { headers: { 'x-api-key': key } });
      if (r.ok) break;
      await sleep(2000);
    }
  }
};
const sha1 = (buf) => crypto.createHash('sha1').update(Buffer.from(buf)).digest('hex');
const fetchBytes = async (url, key) => (await fetch(url, { headers: { 'x-api-key': key } })).arrayBuffer();
// Read a JSON value out of a sidecar's SQLite state, via the sqlite3 CLI the runner
// already uses. Returns null (rather than throwing) when the rig is not local.
import { execFileSync } from 'node:child_process';
const readSidecarKv = (stateDir, name) => {
  try {
    const path = new URL(`../${stateDir}/state.db`, import.meta.url).pathname;
    const out = execFileSync('sqlite3', [path, `SELECT value FROM kv WHERE name='${name}'`],
                             { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? JSON.parse(out) : null;
  } catch { return null; }
};
const until = async (fn, timeoutMs = 90000, everyMs = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = await fn(); if (v) return v; await sleep(everyMs); }
  return null;
};

let ALBUM_ID = ALBUM;
console.log('— stage: seed origin album (4 photos, capture dates spread over 4 days)');
if (ALBUM === '__CREATE__') {
  ALBUM_ID = (await api(A, AKEY, '/albums', j({ albumName: 'cross server album' }))).id;
} else {
  const existing = await albumAssets(A, AKEY, ALBUM_ID);
  if (existing.length) await api(A, AKEY, '/assets', { ...j({ ids: existing.map(a => a.id), force: true }), method: 'DELETE' });
}
const aIds = [];
for (let i = 1; i <= 4; i++) {
  const takenAt = `2026-08-1${i}T10:00:00.000Z`;
  aIds.push(await upload(A, AKEY, `origin-e2e-${i}.jpg`, `og${i}${Date.now() % 10000}`, takenAt));
}
await ensurePreviews(A, AKEY, aIds);
await api(A, AKEY, `/assets/${aIds[0]}`, { ...j({ latitude: 51.5074, longitude: -0.1278 }), method: 'PUT' });
{ // give the origin admin a profile picture so avatar-sync has a source
  const fd = new FormData();
  fd.set('file', new Blob([fs.readFileSync(new URL('./fixtures/fx11.jpg', import.meta.url))], { type: 'image/jpeg' }), 'avatar.jpg');
  await fetch(`${A}/api/users/profile-image`, { method: 'POST', headers: { 'x-api-key': AKEY }, body: fd });
}
await api(A, AKEY, `/albums/${ALBUM_ID}/assets`, { ...j({ ids: aIds }), method: 'PUT' });
check('origin album seeded', (await albumAssets(A, AKEY, ALBUM_ID)).length === 4);

console.log('— stage: create share link + join from B');
let shareKey = (await api(A, AKEY, '/shared-links')).find(l => l.album?.id === ALBUM_ID)?.key;
if (!shareKey) shareKey = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: ALBUM_ID, allowUpload: true }))).key;
// Without Caddy, sidecar and immich are on different ports — the redeem must target the ORIGIN SIDECAR.
const ORIGIN_SIDECAR = process.env.ORIGIN_SIDECAR || A;
// ORIGIN_SIDECAR is resolved by B's sidecar from INSIDE its container (host.docker.internal).
// The security stage calls the origin directly from this process, so it needs a host route.
const ORIGIN_DIRECT = process.env.ORIGIN_SIDECAR_DIRECT || 'http://localhost:8302';
const joinRes = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${shareKey}` }, BKEY))).json();
check('join succeeded', !!joinRes.album, JSON.stringify(joinRes));
check('join manifest = 4 photos', joinRes.photos === 4, `got ${joinRes.photos}`);

console.log('— stage: verify mirror on B');
const bAlbums = await api(B, BKEY, '/albums');
const mirror = bAlbums.find(a => a.albumName === joinRes.album && a.assetCount > 0) || bAlbums.find(a => a.albumName === joinRes.album);
check('mirror exists', !!mirror);
const bUsers = await api(B, BKEY, '/admin/users');
const bUtility = bUsers.filter(u => u.email.endsWith('@sidecar.local'));
const originOwnerName = (await api(A, AKEY, '/users/me')).name;
check(`mirror owner is ${originOwnerName} (via shared albums)`, bUtility.some(u => u.name === `${originOwnerName} (via shared albums)`), bUtility.map(u => u.name).join(', '));
const mAssets = await until(async () => { const x = await albumAssets(B, BKEY, mirror.id); return x.length === 4 ? x : null; });
check('mirror has 4 assets', !!mAssets, mAssets ? '' : 'timed out');
if (mAssets) {
  const humanIds = bUsers.filter(u => !u.email.endsWith('@sidecar.local')).map(u => u.id);
  check('no mirror asset owned by a human on B', mAssets.every(a => !humanIds.includes(a.ownerId)));
  const dates = mAssets.map(a => (a.fileCreatedAt || '').slice(0, 10)).sort();
  check('capture dates preserved (order fix)', JSON.stringify(dates) === JSON.stringify(['2026-08-11','2026-08-12','2026-08-13','2026-08-14']), dates.join(','));
  const withGps = mAssets.find(a => a.exifInfo?.latitude);
  check('GPS location preserved on mirrored photo', !!withGps && Math.abs(withGps.exifInfo.latitude - 51.5074) < 0.001,
        withGps ? `lat=${withGps.exifInfo.latitude}` : 'no GPS on any mirror asset');
  const ownerUtility = bUtility.find(u => u.name === `${originOwnerName} (via shared albums)`);
  check('origin avatar synced onto utility user', !!(ownerUtility && ownerUtility.profileImagePath), ownerUtility?.profileImagePath ? 'has avatar' : 'no avatar');
  const originSums = new Set((await albumAssets(A, AKEY, ALBUM_ID)).map(a => a.checksum));
  check('mirrors are light renditions, not byte copies (reference model)', mAssets.every(a => !originSums.has(a.checksum)));
  const stubSizes = mAssets.map(a => (a.exifInfo || {}).fileSizeInByte || 0);
  check('mirrors are kilobyte stubs — hotlink model stores no pixels', stubSizes.every(n => n > 0 && n < 20000),
        stubSizes.join(','));
  const gpsProxy = withGps || mAssets[0];
  const viaProxy = await fetchBytes(`${BS}/api/assets/${gpsProxy.id}/original`, BKEY);
  const originOrig = await fetchBytes(`${A}/api/assets/${aIds[0]}/original`, AKEY);
  check('on-demand original streams byte-identical from the owner server', sha1(viaProxy) === sha1(originOrig),
        `${viaProxy.byteLength}B via proxy vs ${originOrig.byteLength}B at origin`);
  const thumbRes1 = await fetch(`${BS}/api/assets/${gpsProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } });
  const viaThumb = await thumbRes1.arrayBuffer();
  const originThumb = await fetchBytes(`${A}/api/assets/${aIds[0]}/thumbnail?size=preview`, AKEY);
  check('thumbnails stream live from the owner (hotlink interception)', sha1(viaThumb) === sha1(originThumb),
        `${viaThumb.byteLength}B via proxy vs ${originThumb.byteLength}B at origin`);
  check('first view is a cache MISS', thumbRes1.headers.get('x-cache') === 'MISS', `x-cache: ${thumbRes1.headers.get('x-cache')}`);
  const thumbRes2 = await fetch(`${BS}/api/assets/${gpsProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } });
  check('repeat view is a cache HIT (byte-identical)',
        thumbRes2.headers.get('x-cache') === 'HIT' && sha1(await thumbRes2.arrayBuffer()) === sha1(originThumb),
        `x-cache: ${thumbRes2.headers.get('x-cache')}`);
}

const bAdminUtility = `${(await api(B, BKEY, '/users/me')).name} (via shared albums)`;
console.log(`— stage: B admin contributes 2 photos (old capture dates)`);
const nIds = [];
for (let i = 1; i <= 2; i++) {
  const takenAt = `2026-07-0${i}T09:00:00.000Z`;
  nIds.push(await upload(B, BKEY, `nan-e2e-${i}.jpg`, `nn${i}${Date.now() % 1000}`, takenAt));
}
await ensurePreviews(B, BKEY, nIds);
await api(B, BKEY, `/albums/${mirror.id}/assets`, { ...j({ ids: nIds }), method: 'PUT' });

console.log('— stage: verify arrival + attribution on A');
const aAfter = await until(async () => { const x = await albumAssets(A, AKEY, ALBUM_ID); return x.length === 6 ? x : null; });
check('A album has 6 assets after contribution', !!aAfter, aAfter ? '' : `still ${(await albumAssets(A, AKEY, ALBUM_ID)).length}`);
if (aAfter) {
  const aUsers = await api(A, AKEY, '/admin/users');
  const nanUser = aUsers.find(u => u.name === bAdminUtility);
  check('contributor utility user exists on A', !!nanUser, bAdminUtility);
  const ownerId_A = (await api(A, AKEY, '/users/me')).id;
  const contributed = aAfter.filter(a => !aIds.includes(a.id));
  check('contributions NOT owned by origin admin (timeline clean)', contributed.every(a => a.ownerId !== ownerId_A),
        contributed.map(a => a.ownerId.slice(0, 8)).join(','));
  check('contributions owned by the contributor utility user', nanUser && contributed.every(a => a.ownerId === nanUser.id));
  const credited = contributed.every(a => (a.exifInfo?.description || '').includes('Shared by'));
  check('uploader credited in photo description', credited, contributed.map(a => a.exifInfo?.description).join(' | ').slice(0,80));
  const cDates = contributed.map(a => (a.fileCreatedAt || '').slice(0, 10)).sort();
  check('contribution capture dates preserved', JSON.stringify(cDates) === JSON.stringify(['2026-07-01','2026-07-02']), cDates.join(','));

  console.log('— stage: stale utility-user display name heals on next sync');
  await api(A, AKEY, `/admin/users/${nanUser.id}`, { ...j({ name: 'Shared · Legacy Name' }), method: 'PUT' });
  const healId = await upload(B, BKEY, 'heal-e2e.jpg', `hl${Date.now() % 1000}`, '2026-07-03T09:00:00.000Z');
  await ensurePreviews(B, BKEY, [healId]);
  await api(B, BKEY, `/albums/${mirror.id}/assets`, { ...j({ ids: [healId] }), method: 'PUT' });
  const healed = await until(async () => {
    const u = (await api(A, AKEY, '/admin/users')).find(x => x.id === nanUser.id);
    return u && u.name === bAdminUtility ? u : null;
  }, 60000);
  check('stale utility-user name healed (regression: old "Shared ·" naming)', !!healed,
        healed ? healed.name : 'still stale');
}

console.log('— stage: A personal timeline must NOT contain B-contributed photos');
if (aAfter) {
  const ownerId_A = (await api(A, AKEY, '/users/me')).id;
  // The mobile Photos tab shows the logged-in user's own assets. Query exactly that.
  const myTimeline = (await api(A, AKEY, '/search/metadata', j({ size: 500 }))).assets.items
    .filter(a => a.ownerId === ownerId_A);
  const contributedChecksums = new Set(aAfter.filter(a => !aIds.includes(a.id)).map(a => a.checksum));
  const leaked = myTimeline.filter(a => contributedChecksums.has(a.checksum));
  check('B contributions absent from A owner timeline', leaked.length === 0,
        leaked.length ? `${leaked.length} leaked into personal library` : 'clean');
}

console.log('— stage: album People / owners documented in settings');
if (aAfter) {
  // albumUsers is what the app renders under album Options → People
  const albumDetail = await api(A, AKEY, `/albums/${ALBUM_ID}`);
  const memberNames = (albumDetail.albumUsers || []).map(u => u.user?.name).filter(Boolean);
  check('contributor utility user listed as album member on A', memberNames.includes(bAdminUtility), memberNames.join(', ') || '(none)');
}

console.log('— stage: photo ordering matches capture date (newest-first)');
if (aAfter) {
  const ordered = await api(A, AKEY, '/search/metadata', j({ albumIds: [ALBUM_ID], size: 100, order: 'desc' }));
  const dates = ordered.assets.items.map(a => a.fileCreatedAt);
  const sorted = [...dates].sort().reverse();
  check('album assets returned in capture-date order', JSON.stringify(dates) === JSON.stringify(sorted));
}

console.log('— stage: two-way comment sync');
let joinerComment = '';
if (aAfter && mirror) {
  const originComment = `origin says hi ${Date.now()}`;
  joinerComment = `joiner replies ${Date.now()}`;
  await api(A, AKEY, '/activities', j({ albumId: ALBUM_ID, type: 'comment', comment: originComment }));
  await api(B, BKEY, '/activities', j({ albumId: mirror.id, type: 'comment', comment: joinerComment }));
  const onJoiner = await until(async () => {
    const c = await api(B, BKEY, `/activities?albumId=${mirror.id}&type=comment`);
    return c.some(x => x.comment === originComment) ? c : null;
  }, 40000);
  check('origin comment reached joiner', !!onJoiner);
  const onOrigin = await until(async () => {
    const c = await api(A, AKEY, `/activities?albumId=${ALBUM_ID}&type=comment`);
    return c.some(x => x.comment === joinerComment) ? c : null;
  }, 40000);
  check('joiner comment reached origin', !!onOrigin);
  // no duplication / echo loop
  const finalOrigin = await api(A, AKEY, `/activities?albumId=${ALBUM_ID}&type=comment`);
  check('no comment echo loop', finalOrigin.filter(c => c.comment === originComment).length === 1,
        `${finalOrigin.filter(c => c.comment === originComment).length} copies of origin comment`);
}

console.log('— stage: OWNER adds photos post-join -> member receives (owner-perspective sync)');
if (aAfter && mirror) {
  const lateIds = [];
  for (let i = 1; i <= 2; i++) lateIds.push(await upload(A, AKEY, `late-owner-${i}.jpg`, `lo${i}${Date.now() % 10000}`, `2026-06-0${i}T08:00:00.000Z`));
  await ensurePreviews(A, AKEY, lateIds);
  await api(A, AKEY, `/albums/${ALBUM_ID}/assets`, { ...j({ ids: lateIds }), method: 'PUT' });
  const grew = await until(async () => { const x = await albumAssets(B, BKEY, mirror.id); return x.length === 9 ? x : null; });
  check('owner post-join additions reach member mirror (7->9)', !!grew, grew ? '' : `mirror at ${(await albumAssets(B, BKEY, mirror.id)).length}`);
}

console.log('— stage: same photo shareable into a second album (cross-album dedup bug)');
if (aAfter) {
  const alb2 = (await api(A, AKEY, '/albums', j({ albumName: 'second album' }))).id;
  await api(A, AKEY, `/albums/${alb2}/assets`, { ...j({ ids: [aIds[0]] }), method: 'PUT' });
  const share2 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb2, allowUpload: true }))).key;
  const nanId = (await api(B, BKEY, '/users/me')).id;
  const join2 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${share2}`, forUserId: nanId }, BKEY))).json();
  check('second album join ok', join2.photos === 1, JSON.stringify(join2));
  const mirror2 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'second album');
  const m2assets = await until(async () => { const x = await albumAssets(B, BKEY, mirror2.id); return x.length === 1 ? x : null; }, 40000);
  check('previously-shared photo synced into second album', !!m2assets);
  const m2detail = await api(B, BKEY, `/albums/${mirror2.id}`);
  const m2humans = (m2detail.albumUsers || []).filter(u => !(u.user?.email || '').endsWith('@sidecar.local')).map(u => u.user?.id);
  check('private join: only the receiving user among human members', m2humans.length === 1 && m2humans[0] === nanId, `${m2humans.length} human member(s)`);

  console.log('— stage: re-join by a second user attaches to the existing mirror');
  let second = (await api(B, BKEY, '/admin/users')).find(u => u.email === 'second-e2e@demo.local');
  if (!second) second = await api(B, BKEY, '/admin/users', j({ email: 'second-e2e@demo.local', name: 'Second Human', password: 'e2e-pass-123' }));
  const join2b = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${share2}`, forUserId: second.id }, BKEY))).json();
  check('re-join returns the existing mirror (no duplicate album)', join2b.albumId === mirror2.id, JSON.stringify(join2b).slice(0, 100));
  const dupCount = (await api(B, BKEY, '/albums')).filter(a => a.albumName === 'second album').length;
  check('only one "second album" mirror exists', dupCount === 1, `${dupCount} album(s)`);
  const m2after = await api(B, BKEY, `/albums/${mirror2.id}`);
  const m2h2 = (m2after.albumUsers || []).filter(u => !(u.user?.email || '').endsWith('@sidecar.local')).map(u => u.user?.id);
  check('re-join added the second user as member', m2h2.length === 2 && m2h2.includes(second.id), `${m2h2.length} human member(s)`);

  console.log('— stage: video syncs cross-server as a full original');
  const vidBytes = Buffer.concat([fs.readFileSync(new URL('./fixtures/clip.mp4', import.meta.url)), crypto.randomBytes(8)]);
  const vfd = new FormData();
  vfd.set('deviceAssetId', `e2e-vid-${Date.now() % 100000}`); vfd.set('deviceId', 'e2e-test');
  vfd.set('fileCreatedAt', '2026-08-10T10:00:00.000Z'); vfd.set('fileModifiedAt', '2026-08-10T10:00:00.000Z');
  vfd.set('assetData', new Blob([vidBytes], { type: 'video/mp4' }), 'clip-e2e.mp4');
  const vres = await (await fetch(`${A}/api/assets`, { method: 'POST', headers: { 'x-api-key': AKEY }, body: vfd })).json();
  check('video uploaded to origin', !!vres.id, JSON.stringify(vres).slice(0, 80));
  await api(A, AKEY, `/albums/${alb2}/assets`, { ...j({ ids: [vres.id] }), method: 'PUT' });
  const vArrived = await until(async () => (await albumAssets(B, BKEY, mirror2.id)).find(a => a.type === 'VIDEO') || null, 120000);
  check('video contribution syncs cross-server as a playable rendition', !!vArrived, vArrived ? '' : 'timed out');
  if (vArrived) {
    const vViaProxy = await fetchBytes(`${BS}/api/assets/${vArrived.id}/original`, BKEY);
    const vOrig = await fetchBytes(`${A}/api/assets/${vres.id}/original`, AKEY);
    check('video original streams on demand from the owner', sha1(vViaProxy) === sha1(vOrig),
          `${vViaProxy.byteLength}B via proxy vs ${vOrig.byteLength}B at origin`);
    const rangeRes = await fetch(`${BS}/api/assets/${vArrived.id}/video/playback`,
      { headers: { 'x-api-key': BKEY, Range: 'bytes=0-99' } });
    const rangeBytes = await rangeRes.arrayBuffer();
    check('video playback streams with Range support (seekable hotlink)',
          rangeRes.status === 206 && rangeBytes.byteLength === 100,
          `status ${rangeRes.status}, ${rangeBytes.byteLength}B`);
  }
}

console.log('— stage: instant join (no preview wait) heals via reconciliation');
{
  const alb3 = (await api(A, AKEY, '/albums', j({ albumName: 'instant album' }))).id;
  const fresh = await upload(A, AKEY, 'instant-e2e.jpg', `inst${Date.now() % 100000}`, '2026-08-15T09:00:00.000Z');
  await api(A, AKEY, `/albums/${alb3}/assets`, { ...j({ ids: [fresh] }), method: 'PUT' });
  const share3 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb3, allowUpload: true }))).key;
  const meB = (await api(B, BKEY, '/users/me')).id;
  const join3 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${share3}`, forUserId: meB }, BKEY))).json();
  check('instant join accepted', !!join3.albumId, JSON.stringify(join3).slice(0, 100));
  const m3 = await until(async () => {
    const mirror3 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'instant album');
    if (!mirror3) return null;
    const x = await albumAssets(B, BKEY, mirror3.id);
    return x.length === 1 ? x : null;
  }, 90000);
  check('photo uploaded seconds before join eventually lands (reconciliation)', !!m3, m3 ? 'landed' : 'timed out');
}

console.log('— stage: share link created before any photos (empty album) still names the sharer');
{
  const alb5 = (await api(A, AKEY, '/albums', j({ albumName: 'born empty' }))).id;
  const share5 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb5, allowUpload: true }))).key;
  const meB5 = (await api(B, BKEY, '/users/me')).id;
  const join5 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${share5}`, forUserId: meB5 }, BKEY))).json();
  check('empty-album join succeeds', !!join5.albumId, JSON.stringify(join5).slice(0, 100));
  // Assert the property directly, via the mirror's actual owner. The old form asserted that no
  // household-named utility user existed anywhere, which stopped being a valid proxy once peer
  // stand-ins arrived — a household-named user is now expected and correct.
  const mirror5 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'born empty');
  const owner5 = mirror5
    ? ((await api(B, BKEY, `/albums/${mirror5.id}?withoutAssets=true`)).albumUsers || [])
        .find(au => au.role === 'owner')?.user?.name
    : undefined;
  check('empty-album mirror owner named after the sharer, not the household',
        !!owner5 && !owner5.startsWith('Mock household'), `owner=${owner5}`);
}

console.log('— stage: view-only share link (allowUpload off) rejects cross-server uploads');
{
  const alb6 = (await api(A, AKEY, '/albums', j({ albumName: 'view only album' }))).id;
  const voId = await upload(A, AKEY, 'viewonly-e2e.jpg', `vo${Date.now() % 1000}`, '2026-05-01T09:00:00.000Z');
  await ensurePreviews(A, AKEY, [voId]);
  await api(A, AKEY, `/albums/${alb6}/assets`, { ...j({ ids: [voId] }), method: 'PUT' });
  const share6 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb6, allowUpload: false }))).key;
  const meB6 = (await api(B, BKEY, '/users/me')).id;
  const join6 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${share6}`, forUserId: meB6 }, BKEY))).json();
  const mirror6 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'view only album');
  const m6 = await until(async () => { const x = await albumAssets(B, BKEY, mirror6.id); return x.length === 1 ? x : null; }, 60000);
  check('view-only album still syncs for viewing', !!m6, m6 ? '' : 'timed out');
  const rogue = await upload(B, BKEY, 'rogue-e2e.jpg', `rg${Date.now() % 1000}`, '2026-05-02T09:00:00.000Z');
  await ensurePreviews(B, BKEY, [rogue]);
  await api(B, BKEY, `/albums/${mirror6.id}/assets`, { ...j({ ids: [rogue] }), method: 'PUT' });
  await sleep(25000); // two push cycles
  check('view-only album rejects cross-server uploads', (await albumAssets(A, AKEY, alb6)).length === 1,
        `origin at ${(await albumAssets(A, AKEY, alb6)).length}`);
}

console.log('— stage: reverse-direction share — member-owned album with an already-shared photo must not echo');
{
  // regression: a deduped proxy carries ledger rows from several albums/eras; the wire
  // identity must come from the authoritative (materialisation) row or the origin gets
  // its own photo back as a duplicate
  const CS = process.env.C_SIDECAR || 'http://localhost:8302';
  const REV = process.env.REVERSE_ORIGIN || 'http://host.docker.internal:8301';
  const albR = (await api(B, BKEY, '/albums', j({ albumName: 'reverse album' }))).id;
  await api(B, BKEY, `/albums/${albR}/assets`, { ...j({ ids: [nIds[0]] }), method: 'PUT' });
  const shareR = (await api(B, BKEY, '/shared-links', j({ type: 'ALBUM', albumId: albR, allowUpload: true }))).key;
  const meC = (await api(A, AKEY, '/users/me')).id;
  const joinR = await (await fetch(`${CS}/immich-shared-albums/join`, jAuth({ url: `${REV}/share/${shareR}`, forUserId: meC }, AKEY))).json();
  check('reverse join: C joins a B-owned album', !!joinR.albumId, JSON.stringify(joinR).slice(0, 100));
  const mirrorR = (await api(A, AKEY, '/albums')).find(a => a.albumName === 'reverse album');
  const mR = mirrorR && await until(async () => { const x = await albumAssets(A, AKEY, mirrorR.id); return x.length === 1 ? x : null; }, 180000);
  check('reverse mirror syncs (dedup reuses the existing proxy)', !!mR, mR ? '' : 'timed out');
  await sleep(25000);
  check('already-shared photo does NOT echo back to its owner (regression)',
        (await albumAssets(B, BKEY, albR)).length === 1, `B album at ${(await albumAssets(B, BKEY, albR)).length}`);
}

console.log('— stage: third household D joins — member contributions relay through the origin');
const D = process.env.D_URL || 'http://localhost:2286';
const DS = process.env.D_SIDECAR || 'http://localhost:8303';
const DKEY = process.env.DKEY;
let dMirror = null;
if (DKEY) {
  const joinD = await (await fetch(`${DS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${shareKey}` }, DKEY))).json();
  check('D join succeeded', !!joinD.albumId, JSON.stringify(joinD).slice(0, 100));
  dMirror = (await api(D, DKEY, '/albums')).find(a => a.albumName === joinD.album);
  const dAssets = await until(async () => { const x = await albumAssets(D, DKEY, dMirror.id); return x.length === 9 ? x : null; }, 150000);
  check('D mirror receives all 9 photos incl. B contributions (relay)', !!dAssets,
        dAssets ? '' : `at ${(await albumAssets(D, DKEY, dMirror.id)).length}`);
  const dUtility = (await api(D, DKEY, '/admin/users')).filter(u => u.email.endsWith('@sidecar.local'));
  check('relayed photos attributed to the original contributor on D', dUtility.some(u => u.name === bAdminUtility),
        dUtility.map(u => u.name).join(', '));
  if (dAssets) {
    const nanProxy = dAssets.find(a => (a.fileCreatedAt || '').startsWith('2026-07-01'));
    const viaChain = nanProxy && await fetchBytes(`${DS}/api/assets/${nanProxy.id}/original`, DKEY);
    const bOrig = await fetchBytes(`${B}/api/assets/${nIds[0]}/original`, BKEY);
    check('relayed original chains D -> origin -> B on demand (byte-identical)', !!(viaChain && sha1(viaChain) === sha1(bOrig)),
          viaChain ? `${viaChain.byteLength}B via chain vs ${bOrig.byteLength}B at B` : 'no proxy found for 2026-07-01');
  }
  // comments relay: the origin is the canonical message store, so a late joiner
  // backfills earlier comments — including ones authored by another member household
  const relayedComment = joinerComment && await until(async () => {
    const acts = await api(D, DKEY, `/activities?albumId=${dMirror.id}&type=comment`);
    return acts.find(a => a.comment === joinerComment) || null;
  }, 60000, 4000);
  check('member comment relays to a later-joining household (canonical backfill)', !!relayedComment,
        relayedComment ? `author: ${relayedComment.user?.name}` : 'timed out');
  const dPhoto = await upload(D, DKEY, 'dave-e2e.jpg', `dv${Date.now() % 1000}`, '2026-06-01T09:00:00.000Z');
  await ensurePreviews(D, DKEY, [dPhoto]);
  await api(D, DKEY, `/albums/${dMirror.id}/assets`, { ...j({ ids: [dPhoto] }), method: 'PUT' });
  check('D contribution reaches the origin', !!(await until(async () => (await albumAssets(A, AKEY, ALBUM_ID)).length === 10 ? true : null, 90000)));
  check('D contribution relays onward to B', !!(await until(async () => (await albumAssets(B, BKEY, mirror.id)).length === 10 ? true : null, 150000)));
} else console.log('  (skipped: no DKEY)');

console.log('— stage: deletion propagation + leave-&-purge (reversible joins)');
{
  const albD = (await api(A, AKEY, '/albums', j({ albumName: 'delete test' }))).id;
  const d1 = await upload(A, AKEY, 'del-1.jpg', `dl1${Date.now() % 1000}`, '2026-04-01T09:00:00.000Z');
  const d2 = await upload(A, AKEY, 'del-2.jpg', `dl2${Date.now() % 1000}`, '2026-04-02T09:00:00.000Z');
  await ensurePreviews(A, AKEY, [d1, d2]);
  await api(A, AKEY, `/albums/${albD}/assets`, { ...j({ ids: [d1, d2] }), method: 'PUT' });
  const shareD = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: albD, allowUpload: true }))).key;
  const meBD = (await api(B, BKEY, '/users/me')).id;
  const joinD2 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${shareD}`, forUserId: meBD }, BKEY))).json();
  const mirrorD = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'delete test');
  const mD = await until(async () => { const x = await albumAssets(B, BKEY, mirrorD.id); return x.length === 2 ? x : null; }, 60000);
  check('delete-test album joined and mirrored (2 stubs)', !!mD, mD ? '' : 'timed out');
  await api(A, AKEY, '/assets', { ...j({ ids: [d2], force: true }), method: 'DELETE' });
  const shrunk = await until(async () => (await albumAssets(B, BKEY, mirrorD.id)).length === 1 ? true : null, 240000);
  check('owner deleted a photo -> member stub follows (deletion propagation)', !!shrunk,
        shrunk ? '' : `still ${(await albumAssets(B, BKEY, mirrorD.id)).length}`);
  // leave & purge via the NATIVE gesture: the user leaves the album in the stock app
  // (album settings -> Leave album); the sidecar notices and cleans up everything.
  const stubIds = (await albumAssets(B, BKEY, mirrorD.id)).map(a => a.id);
  await api(B, BKEY, `/albums/${mirrorD.id}/user/me`, { method: 'DELETE' });
  const albumGone = await until(async () =>
    !(await api(B, BKEY, '/albums')).some(a => a.id === mirrorD.id) ? true : null, 90000);
  check('native leave: sidecar removed the mirror album (no custom UI)', !!albumGone);
  let stubsGone = true;
  for (const id of stubIds) {
    const r = await fetch(`${B}/api/assets/${id}`, { headers: { 'x-api-key': BKEY } });
    if (r.ok) { const a = await r.json(); if (!a.isTrashed && !a.deletedAt) stubsGone = false; }
  }
  check('native leave: stubs deleted (space reclaimed)', stubsGone);
}

console.log('— stage: kill test — uncached photos fail closed; cached ones survive from cache');
{
  const all = await albumAssets(B, BKEY, mirror.id);
  const cachedProxy = all.find(a => a.exifInfo?.latitude);          // viewed earlier -> in cache
  const originAll = await albumAssets(A, AKEY, ALBUM_ID);
  const cachedSha = sha1(await fetchBytes(`${A}/api/assets/${aIds[0]}/thumbnail?size=preview`, AKEY));
  // an origin-owned photo that has NEVER been viewed through the interceptor
  const uncachedProxy = all.find(a => !a.exifInfo?.latitude && (a.fileCreatedAt || '').startsWith('2026-08-1'));
  const { execSync } = await import('node:child_process');
  const dockerEnv = { ...process.env, PATH: process.env.PATH + ':/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/usr/bin' };
  execSync('docker stop household-c-sidecar-c-1', { env: dockerEnv, stdio: 'ignore' });
  await sleep(1500);
  const deadRes = await fetch(`${BS}/api/assets/${uncachedProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } });
  const deadBytes = await deadRes.arrayBuffer();
  check('owner offline: UNCACHED photo cannot be produced (no hidden copy exists)',
        deadRes.headers.get('x-cache') === 'BYPASS' && deadBytes.byteLength < 20000,
        `x-cache: ${deadRes.headers.get('x-cache')}, ${deadBytes.byteLength}B`);
  const cachedRes = await fetch(`${BS}/api/assets/${cachedProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } });
  check('owner offline: recently viewed photo still renders FROM CACHE',
        cachedRes.headers.get('x-cache') === 'HIT' && sha1(await cachedRes.arrayBuffer()) === cachedSha);
  execSync('docker start household-c-sidecar-c-1', { env: dockerEnv, stdio: 'ignore' });
  await sleep(4000);
  const aliveRes = await fetch(`${BS}/api/assets/${uncachedProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } });
  check('owner back online: uncached photo streams again (hotlink recovery)',
        aliveRes.headers.get('x-cache') === 'MISS' && (await aliveRes.arrayBuffer()).byteLength > 500,
        `x-cache: ${aliveRes.headers.get('x-cache')}`);
}

console.log('— stage: loop prevention (2 idle watcher cycles)');
await sleep(35000);
const EXPECT = DKEY ? 10 : 9;
check('no ping-pong on A', (await albumAssets(A, AKEY, ALBUM_ID)).length === EXPECT, `A=${(await albumAssets(A, AKEY, ALBUM_ID)).length}`);
check('no ping-pong on B', (await albumAssets(B, BKEY, mirror.id)).length === EXPECT, `B=${(await albumAssets(B, BKEY, mirror.id)).length}`);
if (DKEY && dMirror) check('no ping-pong on D', (await albumAssets(D, DKEY, dMirror.id)).length === EXPECT, `D=${(await albumAssets(D, DKEY, dMirror.id)).length}`);

// ─────────────────────────────────────────────────────────────────────────────
// Security regressions. Each check below maps to a specific hole that existed
// before the hardening pass; they are the reason the sidecar is safe to publish
// on a domain rather than only reachable over a tailnet.
// ─────────────────────────────────────────────────────────────────────────────
// Websockets: the sidecar must be able to front Immich on its own, which means carrying
// protocol upgrades. Without this, live web updates silently die in single-front setups —
// invisible to the mobile apps, which is exactly how it went unnoticed before.
// Native invitations: sharing an album by adding a peer's stand-in user in Immich's OWN
// picker, with no share link involved. The origin detects it by listing albums AS the stand-in
// (which is why this works for albums a non-admin owns), and the member discovers it by polling.
console.log('— stage: native album invitations (no share link)');
{
  const originPeers = readSidecarKv('household-c/c-sidecar', 'peers');
  const bPeer = (originPeers || []).find(p => (p.name || '').includes('(B)'));
  if (!bPeer) console.log('  (skipped: cannot read the origin\'s peer record for B)');
  else {
    const bKeys = readSidecarKv('b-sidecar', 'keys');
    const signAsB = (v) => crypto.sign(null, Buffer.from(v),
      crypto.createPrivateKey({ key: Buffer.from(bKeys.priv, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
    const marker = (await api(A, AKEY, '/admin/users')).find(u => u.name === `${bPeer.name} (via shared albums)`);
    check('origin auto-created a stand-in user for the peer household', !!marker,
          marker ? marker.email : 'not found');

    if (marker) {
      const invAlb = (await api(A, AKEY, '/albums', j({ albumName: 'natively invited album' }))).id;
      const invAsset = await upload(A, AKEY, 'invited.jpg', `inv${Date.now() % 10000}`, '2026-05-01T09:00:00.000Z');
      await ensurePreviews(A, AKEY, [invAsset]);
      await api(A, AKEY, `/albums/${invAlb}/assets`, { ...j({ ids: [invAsset] }), method: 'PUT' });
      // exactly what a human does in the picker
      await api(A, AKEY, `/albums/${invAlb}/users`,
        { ...j({ albumUsers: [{ userId: marker.id, role: 'editor' }] }), method: 'PUT' });
      // 200 is not proof — Immich silently ignores some adds, so read it back
      const back = await api(A, AKEY, `/albums/${invAlb}?withoutAssets=true`);
      check('stand-in is really a member after the invite',
            (back.albumUsers || []).some(au => au.user?.id === marker.id && au.role === 'editor'));

      const mirrored = await until(async () => {
        const al = await api(B, BKEY, '/albums');
        return al.find(a => a.albumName === 'natively invited album') || null;
      }, 150000);
      check('member mirrors an invited album automatically, with no link', !!mirrored,
            mirrored ? '' : 'timed out');
      if (mirrored) {
        const arrived = await until(async () => {
          const x = await albumAssets(B, BKEY, mirrored.id); return x.length >= 1 ? x : null;
        }, 150000);
        check('invited album\'s photo materialises on the member', !!arrived,
              arrived ? '' : 'timed out');
      }

      // Withdrawal. Asserted against the /invitations CONTRACT rather than state.db: the
      // running process is the authoritative view, and the runner deletes state.db from under
      // a live sidecar during purge, so a host-side file read is not a reliable oracle here.
      const invitations = async () => {
        const r = await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/invitations`,
          { headers: { 'x-isa-key': bKeys.pub, 'x-isa-sig': signAsB('invitations') } });
        return r.ok ? ((await r.json()).invitations || []) : null;
      };
      const listedBefore = await invitations();
      check('the invited album is offered on /invitations',
            !!listedBefore?.some(i => i.album?.name === 'natively invited album'),
            JSON.stringify(listedBefore?.map(i => i.album?.name)));
      check('/invitations offers ONLY invitation-shaped shares, never link ones',
            !!listedBefore && listedBefore.every(i => i.album?.name === 'natively invited album'),
            `${listedBefore?.length} entries`);

      await fetch(`${A}/api/albums/${invAlb}/user/${marker.id}`, { method: 'DELETE', headers: { 'x-api-key': AKEY } });
      const retired = await until(async () => {
        const list = await invitations();
        return list && !list.some(i => i.album?.name === 'natively invited album') ? true : null;
      }, 90000);
      check('withdrawing the invite stops it being offered', !!retired, retired ? '' : 'still offered');
    }
  }
}

// The route prefix moved from /sidecar to /immich-shared-albums — a clean break, no shim, so
// both peers must agree on it. Pins the panel answering WITHOUT a trailing slash, and that
// nothing still emits the old prefix.
console.log('— stage: route prefix rename + legacy compatibility');
{
  const code = async (u, init) => (await fetch(u, init).catch(() => ({ status: 0 }))).status;
  const j2 = (o, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(o) });

  check('new prefix: health responds', (await (await fetch(`${BS}/immich-shared-albums/health`)).json()).ok === true);
  // With no shim, /sidecar/* is not ours any more — it falls through to Immich, which may well
  // answer 200 with its SPA shell. So assert it no longer reaches OUR handler, not a status.
  const oldBody = await (await fetch(`${BS}/sidecar/health`).catch(() => ({ text: async () => '' }))).text();
  check('old prefix no longer reaches the sidecar (clean break, no shim)',
        !oldBody.includes('"ok":true'), `body started: ${oldBody.slice(0, 40)}`);

  const noSlash = await code(`${BS}/immich-shared-albums`);
  const withSlash = await code(`${BS}/immich-shared-albums/`);
  check('panel answers WITHOUT a trailing slash', [200, 401, 403].includes(noSlash) && noSlash === withSlash,
        `no-slash=${noSlash} with-slash=${withSlash}`);
  check('panel is still gated on both forms', noSlash === 401, `got ${noSlash}`);

  // the join route must work on the new prefix and remain auth-gated on both
  check('join is gated on the new prefix',
        await code(`${BS}/immich-shared-albums/join`, j2({ url: 'x' }, '')) === 401);

  // the injected banner must reference the NEW prefix, or discovery breaks
  const bannerJs = await (await fetch(`${BS}/immich-shared-albums/banner.js`)).text();
  const bannerOk = bannerJs.includes('/immich-shared-albums/health');
  check('served banner.js points at the new prefix', bannerOk,
        bannerOk ? '' : (bannerJs.includes('/sidecar/health') ? 'still says /sidecar/health' : 'no health probe found'));
  check('served banner.js has no stale /sidecar/ paths', !bannerJs.includes('/sidecar/'));
}

console.log('— stage: websocket upgrades pass through the sidecar');
{
  const http = await import('node:http');
  // the accept hash is derived from the client key, so BOTH handshakes must send the same
  // key for the comparison below to mean anything
  const key = crypto.randomBytes(16).toString('base64');
  const wsHandshake = (base) => new Promise((resolve) => {
    const u = new URL('/api/socket.io/?EIO=4&transport=websocket', base);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    const done = (v) => { try { req.destroy(); } catch {} resolve(v); };
    req.on('upgrade', (res, sock) => { try { sock.destroy(); } catch {} done({ status: 101, accept: res.headers['sec-websocket-accept'] }); });
    req.on('response', (res) => done({ status: res.statusCode }));
    req.on('error', () => done({ status: 0 }));
    setTimeout(() => done({ status: -1 }), 8000);
    req.end();
  });
  const viaSidecar = await wsHandshake(BS);
  const direct = await wsHandshake(B);
  check('websocket upgrade completes through the sidecar (101)', viaSidecar.status === 101, `got ${viaSidecar.status}`);
  check('handshake is byte-exact (same Sec-WebSocket-Accept as Immich direct)',
        !!viaSidecar.accept && viaSidecar.accept === direct.accept,
        `sidecar=${viaSidecar.accept} immich=${direct.accept}`);
}

console.log('— stage: security (unauthenticated surface)');
{
  const status = async (url, init) => (await fetch(url, init).catch(() => ({ status: 0 }))).status;

  check('panel refuses an unauthenticated caller',
        [401, 403].includes(await status(`${BS}/immich-shared-albums/`)), `got ${await status(`${BS}/immich-shared-albums/`)}`);
  check('join refuses an unauthenticated caller',
        await status(`${BS}/immich-shared-albums/join`, j({ url: `${ORIGIN_SIDECAR}/share/${shareKey}` })) === 401);
  check('leave refuses an unauthenticated caller',
        await status(`${BS}/immich-shared-albums/leave`, j({ mappingId: 'whatever' })) === 401);

  const health = await (await fetch(`${BS}/immich-shared-albums/health`)).json();
  check('health exposes liveness only (no household name, no peer count)',
        health.ok === true && !('household' in health) && !('peers' in health), JSON.stringify(health));

  check('oversized body is rejected before it is buffered',
        await status(`${BS}/immich-shared-albums/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                             body: 'x'.repeat(2 * 1024 * 1024) }) === 413);

  check('redeem refuses an unsigned caller',
        await status(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/invites/redeem`,
                     j({ shareKey, protocol: 1, household: { publicKey: 'AAAA', url: 'http://x', name: 'imposter' } })) === 403);

  check('avatar route refuses a bare public key with no signature',
        [403, 405].includes(await status(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/users/${(await api(A, AKEY, '/users/me')).id}/avatar`,
                                         { headers: { 'x-isa-key': 'AAAA' } })));
}

console.log('— stage: security (entitlement — a signed peer is not entitled to everything)');
{
  // Sign as B really is: B's keypair lives in its sidecar volume. Read it with the sqlite3
  // CLI rather than node:sqlite — the runner already depends on the CLI, and node:sqlite
  // needs Node 22+, which would make these checks skip silently on an older host.
  const bKeys = readSidecarKv('b-sidecar', 'keys');
  if (!bKeys) console.log('  (skipped: cannot read B\'s keypair from demo/b-sidecar/state.db)');

  if (bKeys) {
    const signAs = (v) => crypto.sign(null, Buffer.from(v),
      crypto.createPrivateKey({ key: Buffer.from(bKeys.priv, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
    const asB = (v) => ({ headers: { 'x-isa-key': bKeys.pub, 'x-isa-sig': signAs(v) } });

    // A private album on the origin that was never shared with anyone. Before the fix, any
    // enrolled peer could pull its originals with the admin key just by naming the asset.
    const privAlbum = (await api(A, AKEY, '/albums', j({ albumName: 'not shared with anyone' }))).id;
    const privAsset = await upload(A, AKEY, 'private-e2e.jpg', `pv${Date.now() % 10000}`, '2026-07-01T09:00:00.000Z');
    await ensurePreviews(A, AKEY, [privAsset]);
    await api(A, AKEY, `/albums/${privAlbum}/assets`, { ...j({ ids: [privAsset] }), method: 'PUT' });

    const privStatus = (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/assets/${privAsset}/original`, asB(privAsset))).status;
    check('a valid peer CANNOT read an asset that was never shared with it (F-05)',
          privStatus === 403, `got ${privStatus}`);

    // Control: the same signature on an asset B genuinely was offered must still work,
    // otherwise the check above would pass simply by breaking all byte reads.
    const okStatus = (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/assets/${aIds[0]}/original`, asB(aIds[0]))).status;
    check('the same peer CAN still read an asset it was offered (no over-blocking)',
          okStatus === 200, `got ${okStatus}`);

    const manifestStatus = (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/albums/${privAlbum}/manifest`, asB(privAlbum))).status;
    check('a valid peer CANNOT read the manifest of an album not mapped to it (F-06)',
          [403, 404].includes(manifestStatus), `got ${manifestStatus}`);

    await api(A, AKEY, '/assets', { ...j({ ids: [privAsset], force: true }), method: 'DELETE' }).catch(() => {});
    await api(A, AKEY, `/albums/${privAlbum}`, { method: 'DELETE' }).catch(() => {});
  }
}

console.log('— stage: security (album password gates enrolment)');
{
  const pwAlbum = (await api(A, AKEY, '/albums', j({ albumName: 'password album' }))).id;
  const pwAsset = await upload(A, AKEY, 'pw-e2e.jpg', `pw${Date.now() % 10000}`, '2026-07-02T09:00:00.000Z');
  await ensurePreviews(A, AKEY, [pwAsset]);
  await api(A, AKEY, `/albums/${pwAlbum}/assets`, { ...j({ ids: [pwAsset] }), method: 'PUT' });
  const pwKey = (await api(A, AKEY, '/shared-links',
    j({ type: 'ALBUM', albumId: pwAlbum, allowUpload: true, password: 'correct horse' }))).key;
  const meP = (await api(B, BKEY, '/users/me')).id;
  const tryJoin = async (password) => {
    const r = await fetch(`${BS}/immich-shared-albums/join`,
      jAuth({ url: `${ORIGIN_SIDECAR}/share/${pwKey}`, forUserId: meP, password }, BKEY));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const noPw = await tryJoin(undefined);
  check('join without the album password is refused and asks for one',
        noPw.status === 401 && noPw.body.passwordRequired === true, JSON.stringify(noPw.body).slice(0, 120));
  const badPw = await tryJoin('wrong horse');
  check('join with the wrong album password is refused',
        badPw.status >= 400 && !badPw.body.album, JSON.stringify(badPw.body).slice(0, 120));
  const goodPw = await tryJoin('correct horse');
  check('join with the correct album password succeeds', !!goodPw.body.album, JSON.stringify(goodPw.body).slice(0, 160));

  // expiry is honoured too — a link past its date must not enrol anyone
  const expAlbum = (await api(A, AKEY, '/albums', j({ albumName: 'expired album' }))).id;
  const expKey = (await api(A, AKEY, '/shared-links',
    j({ type: 'ALBUM', albumId: expAlbum, expiresAt: '2020-01-01T00:00:00.000Z' }))).key;
  const expRes = await fetch(`${BS}/immich-shared-albums/join`, jAuth({ url: `${ORIGIN_SIDECAR}/share/${expKey}`, forUserId: meP }, BKEY));
  check('join through an expired share link is refused', expRes.status >= 400, `got ${expRes.status}`);
  await api(A, AKEY, `/albums/${expAlbum}`, { method: 'DELETE' }).catch(() => {});
}

console.log('— stage: security (utility accounts cannot be signed into)');
{
  const utility = (await api(B, BKEY, '/admin/users')).filter(u => u.email.endsWith('@sidecar.local'));
  check('utility users exist to own the stubs', utility.length > 0, `${utility.length} found`);
  check('no utility user is an admin', utility.every(u => !u.isAdmin));
  const contributors = readSidecarKv('b-sidecar', 'contributors');
  if (contributors) {
    const entries = Object.values(contributors);
    const withPassword = entries.filter((c) => c.password).length;
    check('utility accounts were actually provisioned with keys', entries.length > 0 && entries.every((c) => c.key),
          `${entries.length} contributor(s)`);
    check('no utility login password is retained in state.db once provisioned',
          withPassword === 0, `${withPassword} of ${entries.length} still stored`);
  } else console.log('  (skipped password-retention check: cannot read demo/b-sidecar/state.db)');
}

const fails = results.filter(r => !r.ok);
console.log(`\n${fails.length === 0 ? '🎉 ALL PASS' : `💥 ${fails.length} FAILURES`} (${results.length} checks)`);
process.exit(fails.length ? 1 : 0);
