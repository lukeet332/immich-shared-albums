// Full-cycle E2E assertion harness: reseed A, reset B, join, contribute, verify.
// Usage: node e2e-test.mjs  (env: AKEY, BKEY, A_URL, B_URL, B_SIDECAR)
const A = process.env.A_URL || 'https://ellul-immich.duckdns.org';
const B = process.env.B_URL || 'http://localhost:2284';
const BS = process.env.B_SIDECAR || 'http://localhost:8301';
const AKEY = process.env.AKEY, BKEY = process.env.BKEY;
const ALBUM = process.env.A_ALBUM || 'fe971232-c7c0-4e6f-9174-741bbb692b0d';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`); };
const api = async (base, key, path, init = {}) => {
  const r = await fetch(`${base}/api${path}`, { ...init, headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.status === 204 ? null : r.json();
};
const j = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
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
const joinRes = await (await fetch(`${BS}/sidecar/join`, j({ url: `${ORIGIN_SIDECAR}/share/${shareKey}` }))).json();
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
}

console.log('— stage: Demo Nan contributes 2 photos (old capture dates)');
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
  const nanUser = aUsers.find(u => u.name === 'Demo Nan (via shared albums)');
  check('Demo Nan (via shared albums) exists on A', !!nanUser);
  const lukeId = (await api(A, AKEY, '/users/me')).id;
  const contributed = aAfter.filter(a => !aIds.includes(a.id));
  check('contributions NOT owned by Luke (timeline clean)', contributed.every(a => a.ownerId !== lukeId),
        contributed.map(a => a.ownerId.slice(0, 8)).join(','));
  check('contributions owned by Demo Nan (via shared albums)', nanUser && contributed.every(a => a.ownerId === nanUser.id));
  const credited = contributed.every(a => (a.exifInfo?.description || '').includes('Shared by'));
  check('uploader credited in photo description', credited, contributed.map(a => a.exifInfo?.description).join(' | ').slice(0,80));
  const cDates = contributed.map(a => (a.fileCreatedAt || '').slice(0, 10)).sort();
  check('contribution capture dates preserved', JSON.stringify(cDates) === JSON.stringify(['2026-07-01','2026-07-02']), cDates.join(','));
}

console.log('— stage: A personal timeline must NOT contain B-contributed photos');
if (aAfter) {
  const lukeId = (await api(A, AKEY, '/users/me')).id;
  // The mobile Photos tab shows the logged-in user's own assets. Query exactly that.
  const myTimeline = (await api(A, AKEY, '/search/metadata', j({ size: 500 }))).assets.items
    .filter(a => a.ownerId === lukeId);
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
  check('Demo Nan (via shared albums) listed as album member on A', memberNames.includes('Demo Nan (via shared albums)'), memberNames.join(', ') || '(none)');
}

console.log('— stage: photo ordering matches capture date (newest-first)');
if (aAfter) {
  const ordered = await api(A, AKEY, '/search/metadata', j({ albumIds: [ALBUM_ID], size: 100, order: 'desc' }));
  const dates = ordered.assets.items.map(a => a.fileCreatedAt);
  const sorted = [...dates].sort().reverse();
  check('album assets returned in capture-date order', JSON.stringify(dates) === JSON.stringify(sorted));
}

console.log('— stage: two-way comment sync');
if (aAfter && mirror) {
  const originComment = `origin says hi ${Date.now()}`;
  const joinerComment = `joiner replies ${Date.now()}`;
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
  const grew = await until(async () => { const x = await albumAssets(B, BKEY, mirror.id); return x.length === 8 ? x : null; });
  check('owner post-join additions reach member mirror (6->8)', !!grew, grew ? '' : `mirror at ${(await albumAssets(B, BKEY, mirror.id)).length}`);
}

console.log('— stage: same photo shareable into a second album (cross-album dedup bug)');
if (aAfter) {
  const alb2 = (await api(A, AKEY, '/albums', j({ albumName: 'second album' }))).id;
  await api(A, AKEY, `/albums/${alb2}/assets`, { ...j({ ids: [aIds[0]] }), method: 'PUT' });
  const share2 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb2, allowUpload: true }))).key;
  const nanId = (await api(B, BKEY, '/users/me')).id;
  const join2 = await (await fetch(`${BS}/sidecar/join`, j({ url: `${ORIGIN_SIDECAR}/share/${share2}`, forUserId: nanId }))).json();
  check('second album join ok', join2.photos === 1, JSON.stringify(join2));
  const mirror2 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'second album');
  const m2assets = await until(async () => { const x = await albumAssets(B, BKEY, mirror2.id); return x.length === 1 ? x : null; }, 40000);
  check('previously-shared photo synced into second album', !!m2assets);
  const m2detail = await api(B, BKEY, `/albums/${mirror2.id}`);
  const m2humans = (m2detail.albumUsers || []).filter(u => !(u.user?.email || '').endsWith('@sidecar.local')).map(u => u.user?.id);
  check('private join: only the receiving user among human members', m2humans.length === 1 && m2humans[0] === nanId, `${m2humans.length} human member(s)`);
}

console.log('— stage: loop prevention (2 idle watcher cycles)');
await sleep(35000);
check('no ping-pong on A', (await albumAssets(A, AKEY, ALBUM_ID)).length === 8, `A=${(await albumAssets(A, AKEY, ALBUM_ID)).length}`);
check('no ping-pong on B', (await albumAssets(B, BKEY, mirror.id)).length === 8, `B=${(await albumAssets(B, BKEY, mirror.id)).length}`);

const fails = results.filter(r => !r.ok);
console.log(`\n${fails.length === 0 ? '🎉 ALL PASS' : `💥 ${fails.length} FAILURES`} (${results.length} checks)`);
process.exit(fails.length ? 1 : 0);
