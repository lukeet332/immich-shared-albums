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

const UTILITY_SUFFIX = ' (via shared albums)';
let USERS = {}; let USERS_AT = 0;
async function usersById(maxAgeMs = 60000) {
  if (Date.now() - USERS_AT > maxAgeMs) {
    try {
      USERS = Object.fromEntries((await immichJson('/admin/users'))
        .map(u => [u.id, { name: u.name, utility: u.email.endsWith('@sidecar.local') }]));
      USERS_AT = Date.now();
    } catch { /* keep stale map */ }
  }
  return USERS;
}
async function ownerName(ownerId) { const u = (await usersById())[ownerId]; return u && !u.utility ? u.name : null; }
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
const originalStream = (assetId) => immich(`/assets/${assetId}/original`);

// A shared photo, described for a peer. For utility-owned proxies (relayed photos)
// the true contributor is recovered from the utility user's name; the credit line we
// append locally is stripped so downstream hops don't stack "Shared by" twice.
async function assetToRef(a) {
  const u = (await usersById())[a.ownerId];
  const displayName = u?.utility ? u.name.replace(UTILITY_SUFFIX, '')
                                 : (a.owner?.name || u?.name || CFG.name);
  const description = (a.exifInfo?.description || '').replace(/(?:\n\n)?Shared by [^\n]*$/, '') || undefined;
  return { originAsset: a.id, checksum: a.checksum, kind: a.type === 'VIDEO' ? 'video' : 'image',
    fileName: a.originalFileName,
    takenAt: a.exifInfo?.dateTimeOriginal || a.fileCreatedAt,
    exif: a.exifInfo ? { latitude: a.exifInfo.latitude, longitude: a.exifInfo.longitude,
      description, rating: a.exifInfo.rating } : undefined,
    contributor: { displayName, originUserId: a.ownerId } };
}

// What may be offered to the peer behind `mappingId`: photos/videos they haven't seen,
// excluding utility-owned proxies of UNKNOWN provenance (pre-originals preview copies —
// their file checksum differs from the source photo's, so echo-safety can't be proven).
// Originals-era proxies keep the source checksum; the per-mapping seen-ledger then
// guarantees a household never receives its own photo back, which is what enables
// relaying member contributions onward to other member households.
const provenanceKnown = (checksum) => state.seen.some(s => s.c === checksum);
async function shareableAssets(assets, mappingId) {
  const users = await usersById();
  return assets.filter(a => (a.type === 'IMAGE' || a.type === 'VIDEO')
    && !seenHas(mappingId, a.checksum)
    && (!users[a.ownerId]?.utility || provenanceKnown(a.checksum)));
}
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
  const credit = ref.contributor?.displayName ? `Shared by ${ref.contributor.displayName}` : '';
  meta.description = [ref.exif?.description, credit].filter(Boolean).join('\n\n') || undefined;
  if (!meta.description) delete meta.description;
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
const slugify = (s) => (s || 'peer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'peer';
async function ensureUtilityUser(displayName) {
  state.contributors = state.contributors || {};
  const slug = slugify(displayName);
  let c = state.contributors[slug];
  const wantedName = `${displayName}${UTILITY_SUFFIX}`;
  if (c && c.key) {                       // already fully provisioned — heal a stale display name
    const current = (await usersById(10000))[c.userId]?.name;
    if (current && current !== wantedName) {
      try {
        await immichJson(`/admin/users/${c.userId}`, { ...jsonBody({ name: wantedName }), method: 'PUT' });
        if (USERS[c.userId]) USERS[c.userId].name = wantedName;
        log(`healed utility user name: "${current}" -> "${wantedName}"`);
      } catch { /* cosmetic — retry next time */ }
    }
    return c;
  }
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
    await immichJson(`/admin/users/${user.id}`, { ...jsonBody({ password, shouldChangePassword: false, name: wantedName }), method: 'PUT' });
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
  c = { ...(c || {}), userId: user.id, key: keyRes.secret, password, namedAs: wantedName };
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
// Everything shareable with the peer behind mappingId (see shareableAssets for the rules).
async function buildManifest(assets, mappingId) {
  const out = [];
  for (const a of await shareableAssets(assets, mappingId)) out.push(await assetToRef(a));
  return out;
}

// Fetch a ref's preview from the peer and create the local proxy copy. Returns
// false (without marking seen) on failure so reconciliation can retry later.
async function materialiseRef(mapping, peerUrl, fallbackName, ref) {
  if (seenHas(mapping.id, ref.checksum)) return true;
  const sigHeaders = (v) => ({ headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(v) } });
  // full original first (keeps quality AND the source checksum — provenance for relay);
  // preview as a last resort for images only
  let pr = await fetch(`${peerUrl}/sidecar/api/v1/assets/${ref.originAsset}/original`, sigHeaders(ref.originAsset));
  if (!pr.ok) {
    if (ref.kind === 'video') { log(`original fetch failed for video ${ref.originAsset}: ${pr.status}`); return false; }
    pr = await fetch(`${peerUrl}/sidecar/api/v1/assets/${ref.originAsset}/preview`, sigHeaders(ref.originAsset));
    if (!pr.ok) { log(`original+preview fetch failed for ${ref.originAsset}: ${pr.status}`); return false; }
  }
  const bytes = Buffer.from(await pr.arrayBuffer());
  const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
  const c = await ensureContributor(ref.contributor?.displayName || fallbackName, mapping.albumId, adminKey, peerUrl, ref.contributor?.originUserId);
  const up = await uploadAsset(bytes, ref.fileName || `shared-${ref.checksum.slice(0, 12)}.jpg`, c.key, ref.takenAt);
  await addToAlbum(mapping.albumId, [up.id], c.key);
  await applyRefMetadata(up.id, ref, c.key);
  seenAdd(mapping.id, ref.checksum, up.id);
  log(`materialised ref from "${ref.contributor?.displayName || fallbackName}" into "${mapping.albumName}"`);
  return true;
}

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
  const manifest = await buildManifest(album.assets, mappingId);
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
    try { if (!(await materialiseRef(mapping, peer.url, peer.name, ref))) failed.push(ref.checksum); }
    catch (e) { log(`ref materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); failed.push(ref.checksum); }
  }
  // partial success: sender re-offers only the failed refs next cycle
  return [200, { ok: failed.length === 0, failed }];
}

// Version handshake: one cheap album read instead of a full manifest scan. Members
// compare this against their stored version and only pull the manifest on mismatch.
async function handleVersion(req, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(albumMappingId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.role === 'owner' && (m.id === albumMappingId || m.albumId === albumMappingId));
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  return [200, { version: (await getAlbum(mapping.albumId)).updatedAt }];
}

// Members re-pull this to heal refs missed at join time (e.g. preview not yet generated).
async function handleManifest(req, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(albumMappingId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.role === 'owner' && (m.id === albumMappingId || m.albumId === albumMappingId));
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  return [200, { manifest: await buildManifest(await getAlbumAssets(mapping.albumId), mapping.id) }];
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

async function handleOriginal(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return originalStream(assetId);
}

// ---------- join (member side) ----------
async function join(shareUrl, forUserId) {
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
  const addMembers = async (albumId) => {
    let members = (await immichJson('/admin/users')).filter(u => !u.email.endsWith('@sidecar.local'));
    if (forUserId) members = members.filter(u => u.id === forUserId); // per-user join: only the receiving user
    const alb = await immichJson(`/albums/${albumId}`, {}, host.key);
    const already = new Set((alb.albumUsers || []).map(au => au.user?.id));
    members = members.filter(u => !already.has(u.id));
    if (members.length) await immichJson(`/albums/${albumId}/users`,
      { ...jsonBody({ albumUsers: members.map(u => ({ userId: u.id, role: 'editor' })) }), method: 'PUT' }, host.key);
    return members.length;
  };
  // same remote album already mirrored here -> just add this user to the existing mirror
  const existing = state.mappings.find(mp => mp.role === 'member' && mp.peer === res.household.publicKey
    && mp.remoteAlbumId === res.album.id && !mp.dead);
  if (existing) {
    const n = await addMembers(existing.albumId);
    log(`re-join: added ${n} member(s) to existing mirror "${existing.albumName}"`);
    return { album: existing.albumName, albumId: existing.albumId, photos: res.manifest.length, from: res.household.name };
  }
  const mirror = await immichJson('/albums', jsonBody({ albumName: CFG.template.replace('{name}', res.album.name) }), host.key);
  try {
    const n = await addMembers(mirror.id);
    log(`mirror shared with ${forUserId ? 'one user (per-user join)' : n + ' household member(s)'}`);
  } catch (e) { log(`could not add local members to mirror: ${e.message}`); }
  const mappingId = crypto.randomUUID();
  state.mappings.push({ id: mappingId, role: 'member', albumId: mirror.id, albumName: mirror.albumName,
    peer: res.household.publicKey, remoteAlbumId: res.album.id, remoteMappingId: res.mappingId,
    permissions: res.album.permissions, adminSlug: slugify(res.albumOwner?.displayName || res.household.name) });
  save();
  log(`joined "${res.album.name}" from "${res.household.name}" (${res.manifest.length} photos)`);
  const newMapping = state.mappings.find(mp => mp.id === mappingId);
  for (const ref of res.manifest) {
    try { await materialiseRef(newMapping, res.household.url, res.household.name, ref); }
    catch (e) { log(`join materialise failed (${ref.checksum?.slice(0,10)}): ${e.message} — reconciliation will retry`); }
  }
  return { album: mirror.albumName, albumId: mirror.id, photos: res.manifest.length, from: res.household.name };
}

// ---------- watcher: local additions -> push refs to peer ----------
async function watchOnce() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;
    try {
      // handshake: skip untouched albums entirely (updatedAt bumps on any album change).
      // localVersion is only stored after a CLEAN cycle so deferred refs keep re-offering.
      const album = await getAlbum(mapping.albumId);
      if (album.updatedAt && album.updatedAt === mapping.localVersion) continue;
      const assets = await getAlbumAssets(mapping.albumId);
      mapping.failCount = 0;
      const fresh = await shareableAssets(assets, mapping.id);
      if (!fresh.length) { mapping.localVersion = album.updatedAt; save(); continue; }
      const peer = state.peers.find(p => p.pub === mapping.peer);
      const targetMapping = mapping.role === 'member' ? (mapping.remoteMappingId || mapping.remoteAlbumId) : mapping.albumId;
      const add = [];
      for (const a of fresh) add.push(await assetToRef(a));
      const body = JSON.stringify({ add });
      const r = await signedFetch(`${peer.url}/sidecar/api/v1/albums/${targetMapping}/refs`, body);
      if (r.ok) {
        const failed = new Set((await r.json().catch(() => ({}))).failed || []);
        const landed = fresh.filter(a => !failed.has(a.checksum));
        landed.forEach(a => seenAdd(mapping.id, a.checksum, a.id));
        if (!failed.size) { mapping.localVersion = album.updatedAt; save(); }
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
  await reconcileOnce();
  await syncComments();
}

// Heal member mirrors: re-pull the origin manifest and materialise anything we
// missed (e.g. previews not yet generated at join time). Cheap no-op when in sync.
async function reconcileOnce() {
  for (const mapping of state.mappings.filter(mp => mp.role === 'member' && !mp.dead)) {
    try {
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      const target = mapping.remoteMappingId || mapping.remoteAlbumId;
      const sig = { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(target) } };
      // handshake first: only pull the full manifest when the origin's version moved.
      // remoteVersion is only stored after a CLEAN pass so failures keep retrying.
      let version = null;
      const vr = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/version`, sig);
      if (vr.ok) {
        version = (await vr.json().catch(() => ({}))).version || null;
        if (version && version === mapping.remoteVersion) continue;
      }
      const r = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/manifest`, sig);
      if (!r.ok) continue;
      const { manifest = [] } = await r.json();
      const missing = manifest.filter(ref => !seenHas(mapping.id, ref.checksum));
      let allOk = true;
      for (const ref of missing) {
        try { if (await materialiseRef(mapping, peer.url, peer.name, ref)) log(`reconciled missed ref into "${mapping.albumName}"`); else allOk = false; }
        catch (e) { allOk = false; log(`reconcile materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); }
      }
      if (allOk && version) { mapping.remoteVersion = version; save(); }
    } catch (e) { log(`reconcile error on "${mapping.albumName}": ${e.message}`); }
  }
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
 body{margin:0;font-family:Overpass,Inter,Roboto,-apple-system,sans-serif;background:#f8f9fa;color:#202124;display:grid;place-items:center;min-height:100vh}
 .card{width:min(440px,calc(100vw - 32px));box-sizing:border-box;background:#fff;border:1px solid rgba(0,0,0,.06);border-radius:28px;padding:30px 26px 26px;text-align:center;box-shadow:0 1px 3px rgba(60,64,67,.15),0 8px 28px rgba(60,64,67,.15)}
 .logo{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;background:linear-gradient(135deg,#4250af,#7c3aed);font-size:26px;box-shadow:0 2px 10px rgba(66,80,175,.35)}
 h1{font-size:19px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em} p{color:#5f6368;font-size:13.5px;line-height:1.55;margin:6px 0 18px}
 button{font:inherit;font-size:15px;font-weight:600;padding:12px 36px;border:0;border-radius:999px;background:#4250af;color:#fff;cursor:pointer;transition:filter .15s,box-shadow .15s}
 button:hover{filter:brightness(1.08);box-shadow:0 2px 10px rgba(66,80,175,.4)} button:disabled{opacity:.4;cursor:default;box-shadow:none}
 #who{font-size:12.5px;color:#4250af;margin:-6px 0 16px;line-height:1.5} #who a{color:#4250af}
 #out{margin-top:16px;font-size:13px;color:#4250af;min-height:20px;line-height:1.5}
 @media (prefers-color-scheme:dark){
  body{background:#101216;color:#e8eaed}
  .card{background:#1b1f26;border-color:rgba(255,255,255,.08);box-shadow:0 1px 3px rgba(0,0,0,.4),0 10px 32px rgba(0,0,0,.5)}
  p{color:#9aa0a6} #who,#who a,#out{color:#a8c7fa}
  button{background:#a8c7fa;color:#0d1b3d}
 }
</style>
<div class="card"><div class="logo">🔗</div><h1 id="t">Join shared album?</h1>
<p id="d">This will add the album to your account on <b>${CFG.name}</b>. Photos stay on their owners' servers.</p>
<div id="who"></div>
<button id="go" disabled>Accept &amp; join</button><div id="out"></div></div>
<script>
const frag=(()=>{
 try{ if(location.hash.length>1) return JSON.parse(decodeURIComponent(location.hash.slice(1))); }catch{}
 const qp=new URLSearchParams(location.search);
 if(qp.get('h')&&qp.get('k')){ const f={v:1,host:qp.get('h'),scheme:qp.get('s')||'https',key:qp.get('k')};
   history.replaceState({},'',location.pathname); return f; }
 return null;})();
if(!frag||!frag.host||!frag.key){document.getElementById('t').textContent='Invalid or expired invite';document.getElementById('go').style.display='none';}
let ME=null,POLL=null;
function whoami(){return fetch('/api/users/me',{credentials:'include'}).then(r=>r.ok?r.json():null).then(u=>{
 if(u&&u.id){ME=u;clearInterval(POLL);document.getElementById('go').disabled=false;
   document.getElementById('who').textContent='Joining as '+u.name+' — the album is added only to your account.';}
 else if(!ME){document.getElementById('who').innerHTML='<a href="/auth/login" target="_blank">Sign in to your Immich</a> to join — this page will notice once you are signed in.';}
 return u;}).catch(()=>null);}
whoami().then(u=>{if(!u)POLL=setInterval(whoami,2500);});
document.getElementById('go').onclick=async()=>{
 if(!ME)return;
 const out=document.getElementById('out');out.textContent='Joining…';
 const scheme=frag.scheme||'https';
 const r=await fetch('/sidecar/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:scheme+'://'+frag.host+'/share/'+frag.key,forUserId:ME.id})});
 const d=await r.json().catch(()=>({error:'failed'}));
 if(r.ok){
   var deep='intent://my.immich.app/albums/'+d.albumId+'#Intent;scheme=https;package=app.alextran.immich;S.browser_fallback_url='+encodeURIComponent('https://my.immich.app/albums/'+d.albumId)+';end';
   out.innerHTML='Joined "'+d.album+'" from '+d.from+' — '+d.photos+' photos syncing.<br><br>'+
     '<a href="'+deep+'" style="display:inline-block;background:#4250af;color:#fff;text-decoration:none;font-weight:600;padding:12px 30px;border-radius:999px">Open in Immich app</a>'+
     '<div style="margin-top:12px;font-size:12px;color:#9aa0a6">If the album looks empty at first, give it a moment — the app is still syncing it.</div>';
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
      try { const b = JSON.parse(body); return send(200, await join(b.url, b.forUserId)); }
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
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/version$/)) && req.method === 'GET') {
      const [code, obj] = await handleVersion(req, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/manifest$/)) && req.method === 'GET') {
      const [code, obj] = await handleManifest(req, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/original$/))) {
      const out = await handleOriginal(req, m[1]);
      if (Array.isArray(out)) return send(out[0], out[1]);
      res.writeHead(200, { 'Content-Type': out.headers.get('content-type') || 'application/octet-stream' });
      return res.end(Buffer.from(await out.arrayBuffer()));
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
