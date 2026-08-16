/**
 * immich-shared-albums — demo-grade v0 core.
 * One process: HTTP server (protocol + panel) + watcher loop.
 * State: JSON file (SQLite arrives with the real implementation).
 * Node >= 20, zero dependencies.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CFG = {
  immichUrl: process.env.IMMICH_URL || 'http://immich-server:2283',
  apiKey: process.env.IMMICH_API_KEY,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  name: process.env.HOUSEHOLD_NAME || 'Unnamed household',
  port: Number(process.env.PORT || 8300),
  dataDir: process.env.DATA_DIR || '/data',
  pollMs: Number(process.env.POLL_MS || 20000),
  template: process.env.ALBUM_TEMPLATE || '{name}',
};
if (!CFG.apiKey) { console.error('IMMICH_API_KEY required'); process.exit(1); }

// ---------- state ----------
const STATE_FILE = path.join(CFG.dataDir, 'state.json');
fs.mkdirSync(CFG.dataDir, { recursive: true });
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { keys: null, peers: [], mappings: [], seen: [] };
if (!state.keys) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  state.keys = {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
save();
const seenHas = (mappingId, checksum) => state.seen.some(s => s.m === mappingId && s.c === checksum);
const seenAdd = (mappingId, checksum, localAssetId) => { state.seen.push({ m: mappingId, c: checksum, l: localAssetId }); save(); };
const log = (...a) => console.log(new Date().toISOString(), ...a);
let BANNER_JS = ''; try { BANNER_JS = fs.readFileSync(new URL('./banner.js', import.meta.url), 'utf8'); } catch { log('banner.js not bundled — share pages will be served un-injected'); }

// ---------- immich client ----------
const immich = async (p, init = {}, key = CFG.apiKey) => {
  const r = await fetch(`${CFG.immichUrl}/api${p}`, {
    ...init, headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`immich ${p} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r;
};
const immichJson = async (p, init, key) => (await immich(p, init, key)).json();
const jsonBody = (obj) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

let USER_NAMES = {}; let USER_NAMES_AT = 0;
async function ownerName(ownerId) {
  if (Date.now() - USER_NAMES_AT > 60000) {
    try {
      USER_NAMES = Object.fromEntries((await immichJson('/admin/users')).filter(u => !u.email.endsWith('@sidecar.local')).map(u => [u.id, u.name]));
      USER_NAMES_AT = Date.now();
    } catch { /* keep stale map */ }
  }
  return USER_NAMES[ownerId] || null;
}
const getSharedLinkByKey = async (key) => (await immichJson('/shared-links')).find(l => l.key === key);
const getAlbum = (id) => immichJson(`/albums/${id}?withoutAssets=true`);
// Immich v3 removed embedded assets from the album endpoint; search/metadata is the stable enumerator.
const getAlbumAssets = async (albumId) => {
  const out = []; let page = 1;
  while (page) {
    const res = await immichJson('/search/metadata', jsonBody({ albumIds: [albumId], page, size: 500, withExif: true }));
    out.push(...(res.assets?.items || []));
    page = res.assets?.nextPage ? Number(res.assets.nextPage) : 0;
  }
  return out;
};
const createAlbum = (albumName) => immichJson('/albums', jsonBody({ albumName }));
const addToAlbum = (albumId, ids, key) => immichJson(`/albums/${albumId}/assets`, { ...jsonBody({ ids }), method: 'PUT' }, key);
const previewStream = (assetId) => immich(`/assets/${assetId}/thumbnail?size=preview`);
async function uploadAsset(bytes, filename, key = CFG.apiKey, takenAt) {
  const fd = new FormData();
  const stamp = takenAt || new Date().toISOString();
  fd.set('deviceAssetId', `isa-${crypto.createHash('sha1').update(bytes).digest('hex')}`);
  fd.set('deviceId', 'immich-shared-albums');
  fd.set('fileCreatedAt', stamp);
  fd.set('fileModifiedAt', stamp);
  fd.set('assetData', new Blob([bytes], { type: 'application/octet-stream' }), filename);
  const r = await fetch(`${CFG.immichUrl}/api/assets`, { method: 'POST', headers: { 'x-api-key': key }, body: fd });
  if (!r.ok) throw new Error(`upload -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.json(); // { id, status }
}

async function applyRefMetadata(assetId, ref, key) {
  const meta = {};
  if (ref.exif?.latitude != null && ref.exif?.longitude != null) { meta.latitude = ref.exif.latitude; meta.longitude = ref.exif.longitude; }
  if (ref.exif?.description) meta.description = ref.exif.description;
  if (ref.exif?.rating) meta.rating = ref.exif.rating;
  if (ref.takenAt) meta.dateTimeOriginal = ref.takenAt;
  if (Object.keys(meta).length) {
    try { await immichJson(`/assets/${assetId}`, { ...jsonBody(meta), method: 'PUT' }, key); }
    catch (e) { log(`metadata apply failed for ${assetId}: ${e.message}`); }
  }
}

// ---------- signing (demo: sign outbound, verify inbound when key known) ----------
const sign = (body) => crypto.sign(null, Buffer.from(body),
  crypto.createPrivateKey({ key: Buffer.from(state.keys.priv, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
const verify = (body, sig, pub) => {
  try {
    return crypto.verify(null, Buffer.from(body), crypto.createPublicKey({
      key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64url'));
  } catch { return false; }
};
const signedFetch = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(body) },
  body,
});

// ---------- contributor utility users ----------
async function ensureUtilityUser(displayName) {
  state.contributors = state.contributors || {};
  const slug = (displayName || 'peer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'peer';
  let c = state.contributors[slug];
  if (c && c.key) return c;               // already fully provisioned
  const email = `shared-${slug}@sidecar.local`;
  // reuse a persisted password if we have one (survives partial-provision retries), else fresh
  const password = c?.password || crypto.randomBytes(18).toString('base64url');
  let user;
  try {
    user = await immichJson('/admin/users', jsonBody({ email, name: `${displayName} (via shared albums)`, password }));
  } catch {
    const all = await immichJson('/admin/users?withDeleted=true');
    user = all.find(u => u.email === email);
    if (!user) throw new Error(`cannot create or find contributor user ${email}`);
    if (user.deletedAt) { await immichJson(`/admin/users/${user.id}/restore`, { method: 'POST' }); log(`restored soft-deleted utility user ${email}`); }
    // admin reset: also clear shouldChangePassword so programmatic login works
    await immichJson(`/admin/users/${user.id}`, { ...jsonBody({ password, shouldChangePassword: false }), method: 'PUT' });
  }
  // Instances with OAuth-only login (passwordLogin disabled) need a brief toggle to mint the key.
  let restorePasswordLoginOff = false;
  try {
    const sysCfg = await immichJson('/system-config');
    if (sysCfg.passwordLogin && sysCfg.passwordLogin.enabled === false) {
      sysCfg.passwordLogin.enabled = true;
      await immichJson('/system-config', { ...jsonBody(sysCfg), method: 'PUT' });
      restorePasswordLoginOff = true;
    }
  } catch { /* config not readable — proceed and let login speak */ }
  let login;
  try {
    login = await (await fetch(`${CFG.immichUrl}/api/auth/login`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  } finally {
    if (restorePasswordLoginOff) {
      try {
        const sysCfg = await immichJson('/system-config');
        sysCfg.passwordLogin.enabled = false;
        await immichJson('/system-config', { ...jsonBody(sysCfg), method: 'PUT' });
      } catch (e) { log(`WARNING: could not restore passwordLogin=disabled: ${e.message}`); }
    }
  }
  if (!login.accessToken) throw new Error(`login failed for ${email} — will retry`);
  const keyRes = await (await fetch(`${CFG.immichUrl}/api/api-keys`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ name: 'sidecar', permissions: ['all'] }) })).json();
  if (!keyRes.secret) throw new Error(`api-key mint failed for ${email} (${JSON.stringify(keyRes).slice(0,120)}) — will retry`);
  c = { ...(c || {}), userId: user.id, key: keyRes.secret, password };
  state.contributors[slug] = c; save();
  log(`provisioned utility user "${displayName} (via shared albums)"`);
  return c;
}
async function syncAvatar(c, peerUrl, originUserId) {
  if (!peerUrl || !originUserId || c.avatarDone) return;
  try {
    const av = await fetch(`${peerUrl}/sidecar/api/v1/users/${originUserId}/avatar`,
      { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(originUserId) } });
    if (av.ok) {
      const fd = new FormData();
      fd.set('file', new Blob([Buffer.from(await av.arrayBuffer())], { type: av.headers.get('content-type') || 'image/jpeg' }), 'avatar.jpg');
      const put = await fetch(`${CFG.immichUrl}/api/users/profile-image`, { method: 'POST', headers: { 'x-api-key': c.key }, body: fd });
      if (put.ok) { c.avatarDone = true; save(); }  // only stop retrying once an avatar actually landed
    }
  } catch { /* avatars are garnish */ }
}
async function ensureContributor(displayName, albumId, adminKey, peerUrl, originUserId) {
  const c = await ensureUtilityUser(displayName);
  if (!c.key) throw new Error(`contributor "${displayName}" has no API key yet — will retry`);
  await syncAvatar(c, peerUrl, originUserId);
  try {
    await immichJson(`/albums/${albumId}/users`, { ...jsonBody({ albumUsers: [{ userId: c.userId, role: 'editor' }] }), method: 'PUT' }, adminKey);
  } catch { /* already a member */ }
  return c;
}

// ---------- protocol handlers ----------
async function handleRedeem(req, body) {
  const { shareKey, household } = JSON.parse(body);
  const link = await getSharedLinkByKey(shareKey);
  if (!link || link.type !== 'ALBUM') return [404, { error: 'unknown share key' }];
  const album = await getAlbum(link.album.id);
  album.assets = await getAlbumAssets(album.id);
  if (!state.peers.some(p => p.pub === household.publicKey)) {
    state.peers.push({ pub: household.publicKey, url: household.url, name: household.name });
  }
  const mappingId = crypto.randomUUID();
  state.mappings.push({ id: mappingId, role: 'owner', albumId: album.id, albumName: album.albumName,
    peer: household.publicKey, permissions: link.allowUpload ? 'contribute' : 'view' });
  save();
  log(`peer joined: "${household.name}" -> album "${album.albumName}"`);
  const manifest = [];
  for (const a of album.assets.filter(x => x.type === 'IMAGE')) {
    manifest.push({ originAsset: a.id, checksum: a.checksum, kind: 'image',
      takenAt: a.exifInfo?.dateTimeOriginal || a.fileCreatedAt,
      exif: a.exifInfo ? { latitude: a.exifInfo.latitude, longitude: a.exifInfo.longitude,
        description: a.exifInfo.description, rating: a.exifInfo.rating } : undefined,
      contributor: { displayName: a.owner?.name || await ownerName(a.ownerId) || CFG.name, originUserId: a.ownerId } });
  }
  // v3 album responses carry no ownerId — majority asset owner is the sharing person
  const ownerCounts = {};
  for (const a of album.assets) ownerCounts[a.ownerId] = (ownerCounts[a.ownerId] || 0) + 1;
  const albumOwnerId = album.ownerId || Object.keys(ownerCounts).sort((x, y) => ownerCounts[y] - ownerCounts[x])[0];
  const albumOwner = { displayName: await ownerName(albumOwnerId) || CFG.name, originUserId: albumOwnerId };
  return [200, {
    household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name },
    album: { id: album.id, name: album.albumName, permissions: link.allowUpload ? 'contribute' : 'view' },
    albumOwner, manifest, mappingId,
  }];
}

async function handleRefs(req, body, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(body, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.id === albumMappingId || m.albumId === albumMappingId || m.remoteAlbumId === albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const { add = [] } = JSON.parse(body);
  const failed = [];
  for (const ref of add) {
    try {
      if (seenHas(mapping.id, ref.checksum)) continue;
      const pr = await fetch(`${peer.url}/sidecar/api/v1/assets/${ref.originAsset}/preview`,
        { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(ref.originAsset) } });
      if (!pr.ok) { log(`preview fetch failed for ${ref.originAsset}: ${pr.status}`); failed.push(ref.checksum); continue; }
      const bytes = Buffer.from(await pr.arrayBuffer());
      const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
      const c = await ensureContributor(ref.contributor?.displayName || peer.name, mapping.albumId, adminKey, peer.url, ref.contributor?.originUserId);
      const up = await uploadAsset(bytes, `shared-${ref.checksum.slice(0, 12)}.jpg`, c.key, ref.takenAt);
      await addToAlbum(mapping.albumId, [up.id], c.key);
      await applyRefMetadata(up.id, ref, c.key);
      seenAdd(mapping.id, ref.checksum, up.id);
      log(`materialised ref from "${ref.contributor?.displayName}" into "${mapping.albumName}"`);
    } catch (e) { log(`ref materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); failed.push(ref.checksum); }
  }
  // partial success: sender re-offers only the failed refs next cycle
  return [200, { ok: failed.length === 0, failed }];
}

// ---------- comment / activity sync ----------
const getComments = (albumId) => immichJson(`/activities?albumId=${albumId}&type=comment`);
const postComment = (albumId, comment, key) => immichJson('/activities', jsonBody({ albumId, type: 'comment', comment }), key);
const seenActHas = (id) => (state.seenActivity || []).includes(id);
const seenActAdd = (id) => { state.seenActivity = state.seenActivity || []; state.seenActivity.push(id); save(); };

async function handleActivity(req, body, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(body, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  const mapping = state.mappings.find(m => m.id === albumMappingId || m.albumId === albumMappingId || m.remoteAlbumId === albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const { comments = [] } = JSON.parse(body);
  for (const cm of comments) {
    const tag = `remote:${cm.id}`;
    if (seenActHas(tag)) continue;
    const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
    const c = await ensureContributor(cm.author || peer.name, mapping.albumId, adminKey, peer.url, cm.authorUserId);
    const posted = await postComment(mapping.albumId, cm.comment, c.key);
    seenActAdd(tag); seenActAdd(`local:${posted.id}`); // don't echo it back
    log(`synced comment from "${cm.author}" into "${mapping.albumName}"`);
  }
  return [200, { ok: true }];
}

async function handlePreview(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return previewStream(assetId); // Response — streamed through below
}

// ---------- join (member side) ----------
async function join(shareUrl) {
  const m = shareUrl.trim().match(/^(https?:\/\/[^/]+)\/share\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('that does not look like an Immich share link');
  const [, origin, shareKey] = m;
  const body = JSON.stringify({ shareKey,
    household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name } });
  const r = await signedFetch(`${origin}/sidecar/api/v1/invites/redeem`, body);
  if (!r.ok) throw new Error(`redeem failed: ${r.status} ${await r.text().catch(() => '')}`);
  const res = await r.json();
  if (!state.peers.some(p => p.pub === res.household.publicKey)) {
    state.peers.push({ pub: res.household.publicKey, url: res.household.url, name: res.household.name });
  }
  const host = await ensureUtilityUser(res.albumOwner?.displayName || res.household.name);
  await syncAvatar(host, res.household.url, res.albumOwner?.originUserId);
  const mirror = await immichJson('/albums', jsonBody({ albumName: CFG.template.replace('{name}', res.album.name) }), host.key);
  try {
    const everyone = (await immichJson('/admin/users')).filter(u => !u.email.endsWith('@sidecar.local'));
    if (everyone.length) await immichJson(`/albums/${mirror.id}/users`,
      { ...jsonBody({ albumUsers: everyone.map(u => ({ userId: u.id, role: 'editor' })) }), method: 'PUT' }, host.key);
  } catch (e) { log(`could not add local members to mirror: ${e.message}`); }
  const mappingId = crypto.randomUUID();
  state.mappings.push({ id: mappingId, role: 'member', albumId: mirror.id, albumName: mirror.albumName,
    peer: res.household.publicKey, remoteAlbumId: res.album.id, remoteMappingId: res.mappingId,
    permissions: res.album.permissions, adminSlug: (res.household.name || 'peer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') });
  save();
  log(`joined "${res.album.name}" from "${res.household.name}" (${res.manifest.length} photos)`);
  for (const ref of res.manifest) {
    if (seenHas(mappingId, ref.checksum)) continue;
    const pr = await fetch(`${res.household.url}/sidecar/api/v1/assets/${ref.originAsset}/preview`,
      { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(ref.originAsset) } });
    if (!pr.ok) { log(`preview fetch failed: ${pr.status}`); continue; }
    const bytes = Buffer.from(await pr.arrayBuffer());
    const c = await ensureContributor(ref.contributor?.displayName || res.household.name, mirror.id, host.key, res.household.url, ref.contributor?.originUserId);
    const up = await uploadAsset(bytes, `shared-${ref.checksum.slice(0, 12)}.jpg`, c.key, ref.takenAt);
    await addToAlbum(mirror.id, [up.id], c.key);
    await applyRefMetadata(up.id, ref, c.key);
    seenAdd(mappingId, ref.checksum, up.id);
  }
  return { album: mirror.albumName, albumId: mirror.id, photos: res.manifest.length, from: res.household.name };
}

// ---------- watcher: local additions -> push refs to peer ----------
async function watchOnce() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;
    try {
      const assets = await getAlbumAssets(mapping.albumId);
      mapping.failCount = 0;
      // fresh = not yet pushed IN THIS MAPPING, and not owned by a utility user
      // (utility-owned assets are proxies we materialised; a real photo shared in one
      //  album must still be shareable in another — dedup is per-mapping by checksum)
      const utilityIds = new Set(Object.values(state.contributors || {}).map(c => c.userId));
      const fresh = assets.filter(a => a.type === 'IMAGE' && !seenHas(mapping.id, a.checksum)
        && !utilityIds.has(a.ownerId));
      if (!fresh.length) continue;
      const peer = state.peers.find(p => p.pub === mapping.peer);
      const targetMapping = mapping.role === 'member' ? (mapping.remoteMappingId || mapping.remoteAlbumId) : mapping.albumId;
      const add = [];
      for (const a of fresh) {
        add.push({ originAsset: a.id, checksum: a.checksum, kind: 'image',
          takenAt: a.exifInfo?.dateTimeOriginal || a.fileCreatedAt,
          exif: a.exifInfo ? { latitude: a.exifInfo.latitude, longitude: a.exifInfo.longitude,
            description: a.exifInfo.description, rating: a.exifInfo.rating } : undefined,
          contributor: { displayName: a.owner?.name || await ownerName(a.ownerId) || CFG.name, originUserId: a.ownerId } });
      }
      const body = JSON.stringify({ add });
      const r = await signedFetch(`${peer.url}/sidecar/api/v1/albums/${targetMapping}/refs`, body);
      if (r.ok) {
        const failed = new Set((await r.json().catch(() => ({}))).failed || []);
        const landed = fresh.filter(a => !failed.has(a.checksum));
        landed.forEach(a => seenAdd(mapping.id, a.checksum, a.id));
        log(`pushed ${landed.length}/${fresh.length} ref(s) to "${peer.name}"${failed.size ? ` (${failed.size} deferred)` : ''}`);
      } else log(`ref push failed: ${r.status}`);
    } catch (e) {
      mapping.failCount = (mapping.failCount || 0) + 1;
      if (/album.read access|Not found/i.test(e.message) && mapping.failCount >= 5) {
        mapping.dead = true; save();
        log(`mapping "${mapping.albumName}" marked dead after ${mapping.failCount} failures (album deleted?) — no longer polled`);
      } else log(`watcher error on "${mapping.albumName}": ${e.message}`);
    }
  }
  await syncComments();
}

// push locally-authored comments (not ones we materialised) to the peer
async function syncComments() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;
    try {
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      const utilityIds = new Set(Object.values(state.contributors || {}).map(c => c.userId));
      const comments = (await getComments(mapping.albumId))
        .filter(a => a.comment && !seenActHas(`local:${a.id}`) && !seenActHas(`remote:${a.id}`) && !utilityIds.has(a.user?.id));
      if (!comments.length) continue;
      const targetMapping = mapping.role === 'member' ? (mapping.remoteMappingId || mapping.remoteAlbumId) : mapping.albumId;
      const payload = comments.map(a => ({ id: a.id, comment: a.comment, author: a.user?.name || CFG.name, authorUserId: a.user?.id }));
      const r = await signedFetch(`${peer.url}/sidecar/api/v1/albums/${targetMapping}/activity`, JSON.stringify({ comments: payload }));
      if (r.ok) { comments.forEach(a => seenActAdd(`local:${a.id}`)); log(`pushed ${comments.length} comment(s) to "${peer.name}"`); }
    } catch (e) { log(`comment sync error on "${mapping.albumName}": ${e.message}`); }
  }
}
setInterval(() => watchOnce().catch(e => log('watch loop:', e.message)), CFG.pollMs);

// ---------- panel ----------
const PANEL = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CFG.name} — shared albums</title>
<style>
 body{margin:0;font-family:Inter,-apple-system,sans-serif;background:#101216;color:#e5e7eb;display:grid;place-items:start center;min-height:100vh}
 main{width:min(560px,92vw);padding:40px 0}
 h1{font-size:20px;letter-spacing:-.02em} h1 small{color:#6b7280;font-weight:400}
 .card{background:#1f2229;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;margin:14px 0}
 form{display:flex;gap:8px} input{flex:1;font:inherit;font-size:14px;padding:10px 12px;border-radius:11px;border:1px solid rgba(255,255,255,.12);background:#15171c;color:inherit;outline:none}
 input:focus{border-color:#4250af;box-shadow:0 0 0 3px rgba(66,80,175,.25)}
 button{font:inherit;font-size:14px;font-weight:600;padding:10px 18px;border:0;border-radius:11px;background:#4250af;color:#fff;cursor:pointer}
 .item{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:14px}
 .muted{color:#6b7280} #msg{font-size:13px;margin-top:10px;color:#8b9cf9;min-height:18px}
</style>
<main>
 <h1>🔗 Shared albums <small>· ${CFG.name}</small></h1>
 <div class="card"><b style="font-size:14px">Join an album</b>
  <p class="muted" style="font-size:13px">Paste a share link from another household.</p>
  <form onsubmit="j(event)"><input id="u" placeholder="https://their-server/share/…"><button>Join</button></form>
  <div id="msg"></div></div>
 <div class="card"><b style="font-size:14px">Shared albums</b>
  ${state.mappings.map(m => `<div class="item"><span>${m.albumName}</span><span class="muted">${m.role} · ${(state.peers.find(p => p.pub === m.peer) || {}).name || ''}</span></div>`).join('') || '<p class="muted" style="font-size:13px">None yet.</p>'}</div>
 <div class="card"><b style="font-size:14px">Connected households</b>
  ${state.peers.map(p => `<div class="item"><span>${p.name}</span><span class="muted">${p.url}</span></div>`).join('') || '<p class="muted" style="font-size:13px">None yet.</p>'}</div>
</main>
<script>async function j(e){e.preventDefault();const el=document.getElementById('msg');el.textContent='Joining…';
 const r=await fetch('join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:document.getElementById('u').value})});
 const d=await r.json().catch(()=>({error:'failed'}));
 el.textContent=r.ok?('Joined "'+d.album+'" from '+d.from+' — '+d.photos+' photos syncing. It will appear in your app shortly.'):('Error: '+(d.error||r.status));
 if(r.ok)setTimeout(()=>location.reload(),2500)}</script>`;

const ACCEPT_PAGE = () => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Join shared album — ${CFG.name}</title>
<style>
 body{margin:0;font-family:Inter,-apple-system,sans-serif;background:#101216;color:#e5e7eb;display:grid;place-items:center;min-height:100vh}
 .card{width:min(440px,90vw);background:#1f2229;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:26px;text-align:center}
 .logo{width:52px;height:52px;border-radius:15px;margin:0 auto 14px;display:grid;place-items:center;background:linear-gradient(135deg,#4250af,#7c3aed);font-size:24px}
 h1{font-size:18px;margin:0 0 6px;letter-spacing:-.01em} p{color:#9ca3af;font-size:13.5px;line-height:1.5;margin:6px 0 18px}
 button{font:inherit;font-size:15px;font-weight:650;padding:12px 34px;border:0;border-radius:12px;background:#22c55e;color:#06130a;cursor:pointer}
 button:hover{filter:brightness(1.08)} #out{margin-top:14px;font-size:13px;color:#8b9cf9;min-height:20px}
</style>
<div class="card"><div class="logo">🔗</div><h1 id="t">Join shared album?</h1>
<p id="d">This will add the album to <b>${CFG.name}</b> — it will appear in your family's Immich apps. Photos stay on their owners' servers.</p>
<button id="go">Accept &amp; join</button><div id="out"></div></div>
<script>
const frag=(()=>{
 try{ if(location.hash.length>1) return JSON.parse(decodeURIComponent(location.hash.slice(1))); }catch{}
 const qp=new URLSearchParams(location.search);
 if(qp.get('h')&&qp.get('k')){ const f={v:1,host:qp.get('h'),scheme:qp.get('s')||'https',key:qp.get('k')};
   history.replaceState({},'',location.pathname); return f; }
 return null;})();
if(!frag||!frag.host||!frag.key){document.getElementById('t').textContent='Invalid or expired invite';document.getElementById('go').style.display='none';}
document.getElementById('go').onclick=async()=>{
 const out=document.getElementById('out');out.textContent='Joining…';
 const scheme=frag.scheme||'https';
 const r=await fetch('/sidecar/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:scheme+'://'+frag.host+'/share/'+frag.key})});
 const d=await r.json().catch(()=>({error:'failed'}));
 if(r.ok){
   var deep='intent://my.immich.app/albums/'+d.albumId+'#Intent;scheme=https;package=app.alextran.immich;S.browser_fallback_url='+encodeURIComponent('https://my.immich.app/albums/'+d.albumId)+';end';
   out.innerHTML='Joined "'+d.album+'" from '+d.from+' — '+d.photos+' photos syncing.<br><br>'+
     '<a href="'+deep+'" style="display:inline-block;background:#4250af;color:#fff;text-decoration:none;font-weight:650;padding:12px 26px;border-radius:12px">Open in Immich app</a>'+
     '<div style="margin-top:10px;font-size:12px;color:#9ca3af">If the album looks empty at first, give it a moment — the app is still syncing it.</div>';
   document.getElementById('go').style.display='none';
 } else { out.textContent='Error: '+(d.error||r.status); }
};
</script>`;

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://x');
    let m;
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/users\/([^/]+)\/avatar$/))) {
      const peerKey = req.headers['x-isa-key'];
      if (!state.peers.some(pp => pp.pub === peerKey)) return send(403, { error: 'unknown peer' });
      try {
        const av = await immich(`/users/${m[1]}/profile-image`);
        res.writeHead(200, { 'Content-Type': av.headers.get('content-type') || 'image/jpeg' });
        return res.end(Buffer.from(await av.arrayBuffer()));
      } catch { return send(404, { error: 'no avatar' }); }
    }
    if (u.pathname === '/sidecar/banner.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(BANNER_JS);
    }
    if (u.pathname === '/sidecar/accept') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(ACCEPT_PAGE());
    }
    if (!u.pathname.startsWith('/sidecar')) {
      // Transparent proxy to Immich for everything that isn't ours (share pages, their
      // /_app bundles, /api calls). In production Caddy usually routes around us; when the
      // sidecar fronts Immich directly (demo/simple setups) this keeps the SPA fully working.
      const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
      const up = await fetch(`${CFG.immichUrl}${req.url}`, {
        method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        redirect: 'manual',
      });
      const outHeaders = {};
      for (const [k, v] of up.headers) if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) outHeaders[k] = v;
      const setCookie = up.headers.getSetCookie?.() || [];
      if (setCookie.length) outHeaders['set-cookie'] = setCookie;
      const ct = up.headers.get('content-type') || '';
      const buf = Buffer.from(await up.arrayBuffer());
      if (req.method === 'GET' && u.pathname.startsWith('/share/') && ct.includes('text/html') && BANNER_JS) {
        let html = buf.toString();
        html = html.includes('</body>') ? html.replace('</body>', '<script src="/sidecar/banner.js" defer></script></body>')
                                        : html + '<script src="/sidecar/banner.js" defer></script>';
        res.writeHead(up.status, outHeaders); return res.end(html);
      }
      res.writeHead(up.status, outHeaders); return res.end(buf);
    }
    if (u.pathname === '/sidecar/' || u.pathname === '/sidecar') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PANEL());
    }
    if (u.pathname === '/sidecar/join' && req.method === 'POST') {
      try { return send(200, await join(JSON.parse(body).url)); }
      catch (e) { return send(400, { error: e.message }); }
    }
    if (u.pathname === '/sidecar/api/v1/invites/redeem' && req.method === 'POST') {
      const [code, obj] = await handleRedeem(req, body); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/activity$/)) && req.method === 'POST') {
      const [code, obj] = await handleActivity(req, body, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/refs$/)) && req.method === 'POST') {
      const [code, obj] = await handleRefs(req, body, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/preview$/))) {
      const out = await handlePreview(req, m[1]);
      if (Array.isArray(out)) return send(out[0], out[1]);
      res.writeHead(200, { 'Content-Type': out.headers.get('content-type') || 'image/jpeg' });
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
    if (u.pathname === '/sidecar/health') return send(200, { ok: true, household: CFG.name, peers: state.peers.length });
    send(404, { error: 'not found' });
  } catch (e) { log('http error:', e.message); send(500, { error: e.message }); }
});
server.listen(CFG.port, () => log(`sidecar "${CFG.name}" listening :${CFG.port} — immich: ${CFG.immichUrl}`));
