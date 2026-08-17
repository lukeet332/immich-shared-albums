/**
 * immich-shared-albums — v0 core.
 * One process: HTTP server (protocol + panel + proxies) + sync loops.
 * State: SQLite via node:sqlite (see store.ts). TypeScript run natively by Node's
 * type stripping — no build step. Node >= 23.6, zero dependencies.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Store } from './store.ts';
import type { Mapping, Peer } from './store.ts';
import type { AssetRef, Household, RedeemResponse } from './types.ts';

const SIDECAR_VERSION = '0.4.1';
const CFG = {
  immichUrl: process.env.IMMICH_URL || 'http://immich-server:2283',
  apiKey: process.env.IMMICH_API_KEY,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  name: process.env.HOUSEHOLD_NAME || 'Unnamed household',
  port: Number(process.env.PORT || 8300),
  dataDir: process.env.DATA_DIR || '/data',
  pollMs: Number(process.env.POLL_MS || 20000),
  template: process.env.ALBUM_TEMPLATE || '{name}',
  // bounded LRU byte-cache for streamed previews (0 disables). A cache, not storage:
  // capped, reclaimable, invisible to libraries — delete the folder any time.
  cacheMaxMb: Number(process.env.CACHE_MAX_MB ?? 512),
};
if (!CFG.apiKey) { console.error('IMMICH_API_KEY required'); process.exit(1); }

// ---------- state (SQLite, crash-safe; see store.ts) ----------
fs.mkdirSync(CFG.dataDir, { recursive: true });
const store = new Store(CFG.dataDir);
const state = store.state;
if (!state.keys) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  state.keys = {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}
const save = () => store.save();
save();
const seenHas = (mappingId: string, checksum: string) => store.seenHas(mappingId, checksum);
const seenAdd = (mappingId: string, checksum: string, localAssetId: string, originAsset?: string) =>
  store.seenAdd(mappingId, checksum, localAssetId, originAsset);
// materialised proxies keep their SOURCE photo's checksum in the ledger — that identity,
// not the local file's checksum (a re-encoded preview), is what travels on the wire.
const ledgerByAsset = (assetId: string) => store.ledgerByAsset(assetId);
const wireChecksum = (a: { id: string; checksum: string }) => ledgerByAsset(a.id)?.c || a.checksum;
const log = (...a) => console.log(new Date().toISOString(), ...a);
let BANNER_JS = ''; try { BANNER_JS = fs.readFileSync(new URL('./banner.js', import.meta.url), 'utf8'); } catch { log('banner.js not bundled — share pages will be served un-injected'); }

// ---------- immich client ----------
const immich = async (p: string, init: RequestInit = {}, key: string = CFG.apiKey) => {
  const r = await fetch(`${CFG.immichUrl}/api${p}`, {
    signal: AbortSignal.timeout(60000),
    ...init, headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`immich ${p} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r;
};
const immichJson = async (p: string, init?: RequestInit, key?: string) => {
  const r = await immich(p, init, key);
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
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
  return { originAsset: a.id, checksum: wireChecksum(a), kind: a.type === 'VIDEO' ? 'video' : 'image',
    fileName: a.originalFileName,
    takenAt: a.exifInfo?.dateTimeOriginal || a.fileCreatedAt,
    exif: a.exifInfo ? { latitude: a.exifInfo.latitude, longitude: a.exifInfo.longitude,
      description, rating: a.exifInfo.rating } : undefined,
    contributor: { displayName, originUserId: a.ownerId } };
}

// What may be offered to the peer behind `mappingId`: photos/videos they haven't seen,
// excluding utility-owned proxies with no ledger entry (unknown provenance). Proxies with
// a ledger entry carry their SOURCE checksum on the wire, so the per-mapping seen-ledger
// guarantees a household never receives its own photo back — which is what enables
// relaying member contributions onward to other member households.
// The full offer set for an album: media we can vouch for (human-owned, or proxies
// with known provenance). This is what manifests advertise — members diff against it,
// so it must NOT exclude already-synced assets.
async function offerableAssets(assets) {
  const users = await usersById();
  return assets.filter(a => (a.type === 'IMAGE' || a.type === 'VIDEO')
    && (!users[a.ownerId]?.utility || !!ledgerByAsset(a.id)));
}
// The push queue: offerable minus what this mapping has already sent.
async function shareableAssets(assets, mappingId) {
  return (await offerableAssets(assets)).filter(a => !seenHas(mappingId, wireChecksum(a)));
}
async function uploadAsset(bytes, filename, key = CFG.apiKey, takenAt) {
  const fd = new FormData();
  const stamp = takenAt || new Date().toISOString();
  fd.set('deviceAssetId', `isa-${crypto.createHash('sha1').update(bytes).digest('hex')}`);
  fd.set('deviceId', 'immich-shared-albums');
  fd.set('fileCreatedAt', stamp);
  fd.set('fileModifiedAt', stamp);
  fd.set('assetData', new Blob([bytes], { type: 'application/octet-stream' }), filename);
  const r = await fetch(`${CFG.immichUrl}/api/assets`, { method: 'POST', headers: { 'x-api-key': key }, body: fd, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`upload -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.json(); // { id, status }
}

// A minimal valid 1x1 JPEG (baseline, grey). Stubs get a random tail for uniqueness —
// Immich dedupes identical bytes per user, and every proxy must stay a distinct asset.
const STUB_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');

async function applyRefMetadata(assetId: string, ref: AssetRef, key: string) {
  const meta: { latitude?: number; longitude?: number; description?: string; rating?: number; dateTimeOriginal?: string } = {};
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
  signal: AbortSignal.timeout(30000),
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
  c = { ...(c || {}), userId: user.id, key: keyRes.secret, password };
  state.contributors[slug] = c; save();
  log(`provisioned utility user "${displayName} (via shared albums)"`);
  return c;
}
async function syncAvatar(c, peerUrl, originUserId) {
  if (!peerUrl || !originUserId || c.avatarDone) return;
  try {
    const av = await fetch(`${peerUrl}/sidecar/api/v1/users/${originUserId}/avatar`,
      { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(originUserId) }, signal: AbortSignal.timeout(30000) });
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
async function buildManifest(assets) {
  const out = [];
  for (const a of await offerableAssets(assets)) out.push(await assetToRef(a));
  return out;
}

// Fetch a ref's preview from the peer and create the local proxy copy. Returns
// false (without marking seen) on failure so reconciliation can retry later.
async function materialiseRef(mapping, peerUrl, fallbackName, ref) {
  if (seenHas(mapping.id, ref.checksum)) return true;
  const sigHeaders = (v) => ({ headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(v) } });
  // Hotlink model: nothing of the photo is stored here. The mirror asset is a ~2KB
  // unique stub that exists so the stock app has a row to render; every actual pixel
  // (thumbnails, previews, playback, originals) streams live from the owner's server
  // through the byte interceptors below. For videos the stub is a playable prefix of
  // the owner's rendition so the tile carries a real poster and duration.
  let bytes: Buffer;
  if (ref.kind === 'video') {
    const pr = await fetch(`${peerUrl}/sidecar/api/v1/assets/${ref.originAsset}/playback`,
      { ...sigHeaders(ref.originAsset), headers: { ...sigHeaders(ref.originAsset).headers, Range: 'bytes=0-2097151' }, signal: AbortSignal.timeout(120000) });
    if (!pr.ok) { log(`playback stub fetch failed for ${ref.originAsset}: ${pr.status}`); return false; }
    bytes = Buffer.concat([Buffer.from(await pr.arrayBuffer()), crypto.randomBytes(8)]);
  } else {
    bytes = Buffer.concat([STUB_JPEG, crypto.randomBytes(8)]);
  }
  const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
  const c = await ensureContributor(ref.contributor?.displayName || fallbackName, mapping.albumId, adminKey, peerUrl, ref.contributor?.originUserId);
  const ext = ref.kind === 'video' ? 'mp4' : 'jpg';
  // base64 checksums contain / and + — never let them into filenames
  const slug = ref.checksum.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const up = await uploadAsset(bytes, `shared-${slug}.${ext}`, c.key, ref.takenAt);
  await addToAlbum(mapping.albumId, [up.id], c.key);
  await applyRefMetadata(up.id, ref, c.key);
  seenAdd(mapping.id, ref.checksum, up.id, ref.originAsset);
  log(`materialised ref from "${ref.contributor?.displayName || fallbackName}" into "${mapping.albumName}"`);
  return true;
}

async function handleRedeem(req, body) {
  const { shareKey, household, protocol, version } = JSON.parse(body);
  if (protocol && protocol > 1) log(`peer "${household?.name}" speaks protocol ${protocol} > ours (1) — update the immich-shared-albums sidecar on this server`);
  const link = await getSharedLinkByKey(shareKey);
  if (!link || link.type !== 'ALBUM') return [404, { error: 'unknown share key' }];
  const album = await getAlbum(link.album.id);
  album.assets = await getAlbumAssets(album.id);
  if (!state.peers.some(p => p.pub === household.publicKey)) {
    state.peers.push({ pub: household.publicKey, url: household.url, name: household.name, version });
  } else if (version) {
    const pe = state.peers.find(p => p.pub === household.publicKey); if (pe) pe.version = version;
  }
  const mappingId = crypto.randomUUID();
  state.mappings.push({ id: mappingId, role: 'owner', albumId: album.id, albumName: album.albumName,
    peer: household.publicKey, permissions: link.allowUpload ? 'contribute' : 'view' });
  save();
  log(`peer joined: "${household.name}" -> album "${album.albumName}"`);
  const manifest = await buildManifest(album.assets);
  // v3 album responses carry no ownerId — the share link records its creator, which is
  // exactly "the person who shared this"; majority asset owner is the empty-proof fallback
  const ownerCounts = {};
  for (const a of album.assets) ownerCounts[a.ownerId] = (ownerCounts[a.ownerId] || 0) + 1;
  const albumOwnerId = link.userId || album.ownerId || Object.keys(ownerCounts).sort((x, y) => ownerCounts[y] - ownerCounts[x])[0];
  const albumOwner = { displayName: await ownerName(albumOwnerId) || CFG.name, originUserId: albumOwnerId };
  return [200, {
    protocol: 1, version: SIDECAR_VERSION,
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
  // the share link's "allow public user to upload" switch, honoured cross-server
  if (mapping.permissions === 'view') return [403, { error: 'view-only album — uploads not allowed' }];
  const { add = [] } = JSON.parse(body);
  const failed = [];
  for (const ref of add) {
    try { if (!(await materialiseRef(mapping, peer.url, peer.name, ref))) failed.push(ref.checksum); }
    catch (e) { log(`ref materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); failed.push(ref.checksum); }
  }
  if (add.length > failed.length) nudgePeers(mapping.albumId, peerKey); // relay moved — tell the others
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
  const stats = await immichJson(`/activities/statistics?albumId=${mapping.albumId}`).catch(() => null);
  const album = await getAlbum(mapping.albumId);
  // updatedAt alone misses cascade deletions (removing an asset from the library skips
  // the album's timestamp) — fold the asset count in so deletions move the version too
  return [200, { version: `${album.updatedAt}|${album.assetCount ?? ''}`, comments: stats?.comments ?? null }];
}

// Delete a materialised proxy asset. Hard guard: only utility-owned assets are ever
// deleted — resolved via the owning contributor's own key. Human photos are untouchable.
async function deleteProxyAsset(assetId: string): Promise<boolean> {
  try {
    let asset;
    try { asset = await immichJson(`/assets/${assetId}`); }
    catch (e) { if (/-> 404/.test(e.message)) return true; throw e; } // already gone
    const owner = Object.values(state.contributors).find(c => c.userId === asset.ownerId);
    if (!owner) { log(`proxy delete refused for ${assetId}: owner ${asset.ownerId} is not a utility user`); return false; }
    await immichJson('/assets', { ...jsonBody({ ids: [assetId], force: true }), method: 'DELETE' }, owner.key);
    return true;
  } catch (e) { log(`proxy delete failed for ${assetId}: ${e.message}`); return false; }
}

// Leave & purge: the reverse of joining. Removes every stub this album materialised
// (utility-owner-guarded), the mirror album, the mapping and its ledger — a join is
// fully reversible and reclaims all space it ever took.
async function leaveAlbum(mappingId: string) {
  const mapping = state.mappings.find(mp => mp.id === mappingId);
  if (!mapping || mapping.role !== 'member') throw new Error('unknown mapping (only joined albums can be left)');
  let removed = 0;
  for (const entry of store.seenForMapping(mapping.id)) {
    if (entry.o && await deleteProxyAsset(entry.l)) removed++;
  }
  const host = mapping.adminSlug ? state.contributors[mapping.adminSlug] : undefined;
  if (host?.key) {
    try { await immichJson(`/albums/${mapping.albumId}`, { method: 'DELETE' }, host.key); }
    catch (e) { log(`mirror album delete failed: ${e.message}`); }
  }
  store.seenRemoveMapping(mapping.id);
  state.mappings = state.mappings.filter(mp => mp.id !== mapping.id);
  save();
  log(`left "${mapping.albumName}" — ${removed} stub(s) purged`);
  return { left: mapping.albumName, purged: removed };
}

// Nudge: tell every OTHER household mapped to this album that it moved, so they pull
// now instead of at their next tick. Fire-and-forget — a lost nudge costs nothing,
// the scheduled handshake still catches everything (fail-open by design).
function nudgePeers(albumId: string, exceptPeerPub?: string) {
  for (const mp of state.mappings) {
    if (mp.albumId !== albumId || mp.dead || mp.role !== 'owner' || mp.peer === exceptPeerPub) continue;
    const peer = state.peers.find(p => p.pub === mp.peer);
    if (!peer) continue;
    signedFetch(`${peer.url}/sidecar/api/v1/albums/${albumId}/nudge`, JSON.stringify({ album: albumId }))
      .catch(() => { /* fail-open */ });
  }
}

async function handleNudge(req, body, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(body, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.id === albumMappingId || m.albumId === albumMappingId || m.remoteAlbumId === albumMappingId);
  if (!mapping || mapping.dead) return [404, { error: 'unknown album mapping' }];
  // answer fast; do the pull in the background
  (async () => {
    try {
      if (mapping.role === 'member') {
        await reconcileMapping(mapping, peer);
        await pullCanonicalComments(mapping, peer);
      }
    } catch (e) { log(`nudge pull error on "${mapping.albumName}": ${e.message}`); }
  })();
  return [200, { ok: true }];
}

// Members re-pull this to heal refs missed at join time (e.g. preview not yet generated).
async function handleManifest(req, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(albumMappingId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.role === 'owner' && (m.id === albumMappingId || m.albumId === albumMappingId));
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  return [200, { manifest: await buildManifest(await getAlbumAssets(mapping.albumId)) }];
}

// ---------- comment / activity sync ----------
const getComments = (albumId) => immichJson(`/activities?albumId=${albumId}&type=comment`);
const postComment = (albumId, comment, key) => immichJson('/activities', jsonBody({ albumId, type: 'comment', comment }), key);
const seenActHas = (id: string) => store.seenActHas(id);
const seenActAdd = (id: string) => store.seenActAdd(id);

// Materialise foreign comments locally via the author's utility user. Skips ids already
// seen AND (author, text) pairs already present locally — the latter guards legacy comments
// synced before canonical ids existed.
async function materialiseComments(mapping, peerUrl, peerName, comments) {
  const users = await usersById();
  const local = await getComments(mapping.albumId);
  const localPairs = new Set(local.map(a => {
    const n = (users[a.user?.id]?.name || a.user?.name || '').replace(UTILITY_SUFFIX, '');
    return `${n}\u0000${a.comment}`;
  }));
  const ids = {};
  for (const cm of comments) {
    const tag = `remote:${cm.id}`;
    if (seenActHas(tag)) continue;
    if (localPairs.has(`${cm.author}\u0000${cm.comment}`)) { seenActAdd(tag); continue; }
    const adminKey = mapping.adminSlug ? state.contributors[mapping.adminSlug]?.key : undefined;
    const c = await ensureContributor(cm.author || peerName, mapping.albumId, adminKey, peerUrl, cm.authorUserId);
    const posted = await postComment(mapping.albumId, cm.comment, c.key);
    ids[cm.id] = posted.id;
    seenActAdd(tag); seenActAdd(`local:${posted.id}`); // don't echo it back
    log(`synced comment from "${cm.author}" into "${mapping.albumName}"`);
  }
  return ids;
}

async function handleActivity(req, body, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(body, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  const mapping = state.mappings.find(m => m.id === albumMappingId || m.albumId === albumMappingId || m.remoteAlbumId === albumMappingId);
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const { comments = [] } = JSON.parse(body);
  const ids = await materialiseComments(mapping, peer.url, peer.name, comments);
  if (Object.keys(ids).length) nudgePeers(mapping.albumId, peerKey); // new messages — tell the others
  return [200, { ok: true, ids }];
}

// Canonical comment list for an album — the origin is the source of truth for messages.
// Utility-authored entries resolve back to the true contributor's name.
async function handleComments(req, albumMappingId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(albumMappingId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown or unverified peer' }];
  const mapping = state.mappings.find(m => m.role === 'owner' && (m.id === albumMappingId || m.albumId === albumMappingId));
  if (!mapping) return [404, { error: 'unknown album mapping' }];
  const users = await usersById();
  const comments = (await getComments(mapping.albumId)).filter(a => a.comment).map(a => ({
    id: a.id, comment: a.comment, createdAt: a.createdAt,
    author: (users[a.user?.id]?.name || a.user?.name || CFG.name).replace(UTILITY_SUFFIX, ''),
    authorUserId: a.user?.id,
  }));
  return [200, { comments }];
}

async function handlePreview(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return fetchTrueBytes(assetId, 'preview'); // chains for relayed assets
}

// ---- bounded LRU preview cache (files under <dataDir>/cache; accounting in SQLite) ----
const CACHE_DIR = `${CFG.dataDir}/cache`;
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cacheKey = (originAsset: string) => crypto.createHash('sha1').update(originAsset).digest('hex');
function cacheRead(originAsset: string): Buffer | null {
  if (!CFG.cacheMaxMb) return null;
  const key = cacheKey(originAsset);
  if (!store.cacheTouch(key)) return null;
  try { return fs.readFileSync(`${CACHE_DIR}/${key}`); }
  catch { return null; } // index said yes, disk said no — self-heals on next put
}
function cacheWrite(originAsset: string, bytes: Buffer) {
  if (!CFG.cacheMaxMb || bytes.length > CFG.cacheMaxMb * 1024 * 1024 / 10) return; // no single item >10% of cap
  const key = cacheKey(originAsset);
  try {
    fs.writeFileSync(`${CACHE_DIR}/${key}`, bytes);
    store.cachePut(key, bytes.length);
    while (store.cacheTotal() > CFG.cacheMaxMb * 1024 * 1024) {
      const evicted = store.cacheEvictOldest();
      if (!evicted) break;
      try { fs.unlinkSync(`${CACHE_DIR}/${evicted.key}`); } catch { /* already gone */ }
    }
  } catch (e) { log(`cache write skipped: ${e.message}`); }
}

// Resolve true bytes for any local asset: local file for our own photos; for a proxy
// (ledger entry with `o`), chain the fetch to the owner's server — how a relayed
// photo's pixels stream D <- origin <- contributor. Range passes through for players.
async function fetchTrueBytes(assetId: string, kind: 'preview' | 'original' | 'playback', range?: string) {
  const entry = store.ledgerWithOrigin(assetId);
  if (entry) {
    const mapping = state.mappings.find(mp => mp.id === entry.m);
    const peer = mapping && state.peers.find(p => p.pub === mapping.peer);
    if (peer) {
      const headers: Record<string, string> = { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(entry.o) };
      if (range) headers.Range = range;
      const up = await fetch(`${peer.url}/sidecar/api/v1/assets/${entry.o}/${kind}`, { headers });
      if (up.ok) return up;
      log(`chained ${kind} fetch failed (${up.status}) — serving local stub`);
    }
  }
  const local = kind === 'original' ? `/assets/${assetId}/original`
    : kind === 'playback' ? `/assets/${assetId}/video/playback`
    : `/assets/${assetId}/thumbnail?size=preview`;
  return immich(local, range ? { headers: { Range: range } } : {});
}

async function handleOriginal(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return fetchTrueBytes(assetId, 'original', req.headers.range);
}

async function handlePlayback(req, assetId) {
  const peerKey = req.headers['x-isa-key'];
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer || !verify(assetId, req.headers['x-isa-sig'] || '', peerKey)) return [403, { error: 'unknown peer' }];
  return fetchTrueBytes(assetId, 'playback', req.headers.range);
}

// ---------- join (member side) ----------
async function join(shareUrl, forUserId) {
  const m = shareUrl.trim().match(/^(https?:\/\/[^/]+)\/share\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('that does not look like an Immich share link');
  const [, origin, shareKey] = m;
  const body = JSON.stringify({ shareKey, protocol: 1, version: SIDECAR_VERSION,
    household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name } });
  const r = await signedFetch(`${origin}/sidecar/api/v1/invites/redeem`, body);
  if (!r.ok) throw new Error(`redeem failed: ${r.status} ${await r.text().catch(() => '')}`);
  const res = await r.json();
  if (res.protocol && res.protocol > 1) log(`origin "${res.household?.name}" speaks protocol ${res.protocol} > ours (1) — update the immich-shared-albums sidecar on this server`);
  if (!state.peers.some(p => p.pub === res.household.publicKey)) {
    state.peers.push({ pub: res.household.publicKey, url: res.household.url, name: res.household.name, version: res.version });
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
    return { album: existing.albumName, albumId: existing.albumId, photos: res.manifest.length, from: res.household.name, permissions: res.album.permissions, mappingId: existing.id };
  }
  // a freshly-minted utility user/key can 500 its first writes on cold instances — retry
  // with backoff and log each attempt so failures are diagnosable from CI logs
  let mirror;
  for (let attempt = 1; ; attempt++) {
    try { mirror = await immichJson('/albums', jsonBody({ albumName: CFG.template.replace('{name}', res.album.name) }), host.key); break; }
    catch (e) {
      log(`mirror album create attempt ${attempt} failed: ${e.message}`);
      if (attempt >= 6) throw e;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
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
  // the join answers immediately — materialisation happens right behind it via the
  // reconciler (a big album or video transcode must not hold the accept page hostage)
  const newMapping = state.mappings.find(mp => mp.id === mappingId);
  const peerRec = state.peers.find(pe => pe.pub === res.household.publicKey);
  if (newMapping && peerRec) {
    (async () => {
      try { await reconcileMapping(newMapping, peerRec); await pullCanonicalComments(newMapping, peerRec); }
      catch (e) { log(`post-join sync error: ${e.message} — the loops will retry`); }
    })();
  }
  return { album: mirror.albumName, albumId: mirror.id, photos: res.manifest.length, from: res.household.name, permissions: res.album.permissions, mappingId };
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
      // native leave: when the last human member leaves the mirror in the STOCK app
      // (album settings -> Leave album), the sidecar cleans up everything the join
      // created — stubs, mirror, mapping, ledger. No custom UI involved.
      if (mapping.role === 'member') {
        const users = await usersById();
        const humans = (album.albumUsers || []).filter((au) => {
          const u = users[au.user?.id]; return u && !u.utility;
        });
        if (humans.length === 0) { await leaveAlbum(mapping.id); continue; }
      }
      if (mapping.role === 'member' && mapping.permissions === 'view') continue; // view-only: nothing to push
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
        const landed = fresh.filter(a => !failed.has(wireChecksum(a)));
        landed.forEach(a => seenAdd(mapping.id, wireChecksum(a), a.id));
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
}

// Heal member mirrors: re-pull the origin manifest and materialise anything we
// missed (e.g. previews not yet generated at join time). Cheap no-op when in sync.
async function reconcileOnce() {
  for (const mapping of state.mappings.filter(mp => mp.role === 'member' && !mp.dead)) {
    try {
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      await reconcileMapping(mapping, peer);
    } catch (e) { log(`reconcile error on "${mapping.albumName}": ${e.message}`); }
  }
}

// per-mapping mutex: the join-time reconcile is fired unawaited and can race the
// interval loop — both would materialise the same "missing" refs (stubs are unique
// bytes, so Immich cannot dedup the collision into one asset).
const RECONCILING = new Set<string>();
async function reconcileMapping(mapping: Mapping, peer: Peer) {
  if (RECONCILING.has(mapping.id)) return;
  RECONCILING.add(mapping.id);
  try {
      const target = mapping.remoteMappingId || mapping.remoteAlbumId;
      const sig = { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(target) } };
      // handshake first: only pull the full manifest when the origin's version moved.
      // remoteVersion is only stored after a CLEAN pass so failures keep retrying.
      let version = null;
      const vr = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/version`, { ...sig, signal: AbortSignal.timeout(15000) });
      if (vr.ok) {
        version = (await vr.json().catch(() => ({}))).version || null;
        if (version && version === mapping.remoteVersion) return;
      }
      const r = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/manifest`, { ...sig, signal: AbortSignal.timeout(30000) });
      if (!r.ok) return;
      const { manifest = [] } = await r.json();
      // The version's asset count comes from the album table (instant); the manifest
      // comes from the search index (which lags behind deletes). Only trust a read
      // where the two agree — dirty reads retry next cycle instead of poisoning the cursor.
      const expectedCount = version ? Number(String(version).split('|')[1]) : NaN;
      const consistent = !Number.isFinite(expectedCount) || manifest.length === expectedCount;
      if (process.env.RECONCILE_DEBUG) log(`DBG reconcile "${mapping.albumName}": version=${version} cursor=${mapping.remoteVersion} manifest=${manifest.length} expected=${expectedCount} consistent=${consistent} ledger=${store.seenForMapping(mapping.id).length}`);
      // deletion propagation: refs we materialised that the owner no longer offers are
      // gone at the source — remove our stubs too (utility-owner-guarded).
      let propagated = true;
      if (version && consistent) {
        const offered = new Set(manifest.map((x) => x.checksum));
        for (const entry of store.seenForMapping(mapping.id)) {
          if (process.env.RECONCILE_DEBUG) log(`DBG entry c=${entry.c.slice(0,8)} o=${!!entry.o} offered=${offered.has(entry.c)}`);
          if (!entry.o || offered.has(entry.c)) continue;
          if (await deleteProxyAsset(entry.l)) {
            store.seenRemoveEntry(mapping.id, entry.c);
            log(`removed stub for a photo its owner deleted ("${mapping.albumName}")`);
          } else propagated = false; // keep the cursor back so the removal retries next cycle
        }
      }
      const missing = manifest.filter(ref => !seenHas(mapping.id, ref.checksum));
      let allOk = true;
      for (const ref of missing) {
        try { if (await materialiseRef(mapping, peer.url, peer.name, ref)) log(`reconciled missed ref into "${mapping.albumName}"`); else allOk = false; }
        catch (e) { allOk = false; log(`reconcile materialise failed (${ref.checksum?.slice(0,10)}): ${e.message}`); }
      }
      if (allOk && propagated && version && consistent) { mapping.remoteVersion = version; save(); }
  } finally { RECONCILING.delete(mapping.id); }
}

// push locally-authored comments (not ones we materialised) to the peer.
// Runs on its own fast cadence; the cheap activity-count statistic gates the real work,
// so cross-server comments land in seconds without heavy polling.
let COMMENTS_RUNNING = false;
async function syncComments() {
  if (COMMENTS_RUNNING) return;
  COMMENTS_RUNNING = true;
  try { await syncCommentsOnce(); } finally { COMMENTS_RUNNING = false; }
}
async function syncCommentsOnce() {
  for (const mapping of state.mappings) {
    if (mapping.dead) continue;
    try {
      const peer = state.peers.find(p => p.pub === mapping.peer);
      if (!peer) continue;
      if (mapping.role === 'member') await pullCanonicalComments(mapping, peer);
      const stats = await immichJson(`/activities/statistics?albumId=${mapping.albumId}`).catch(() => null);
      if (stats && stats.comments === mapping.commentCount) continue;
      const utilityIds = new Set(Object.values(state.contributors || {}).map(c => c.userId));
      const comments = (await getComments(mapping.albumId))
        .filter(a => a.comment && !seenActHas(`local:${a.id}`) && !seenActHas(`remote:${a.id}`) && !utilityIds.has(a.user?.id));
      if (!comments.length) { if (stats) { mapping.commentCount = stats.comments; save(); } continue; }
      const targetMapping = mapping.role === 'member' ? (mapping.remoteMappingId || mapping.remoteAlbumId) : mapping.albumId;
      const payload = comments.map(a => ({ id: a.id, comment: a.comment, author: a.user?.name || CFG.name, authorUserId: a.user?.id }));
      const r = await signedFetch(`${peer.url}/sidecar/api/v1/albums/${targetMapping}/activity`, JSON.stringify({ comments: payload }));
      if (r.ok) {
        comments.forEach(a => seenActAdd(`local:${a.id}`));
        // the origin answers with canonical ids for our comments — remember them so the
        // canonical pull can never hand us our own comments back
        const { ids = {} } = await r.json().catch(() => ({}));
        for (const originId of Object.values(ids)) seenActAdd(`remote:${originId}`);
        if (stats) { mapping.commentCount = stats.comments; save(); }
        log(`pushed ${comments.length} comment(s) to "${peer.name}"`);
      }
    } catch (e) { log(`comment sync error on "${mapping.albumName}": ${e.message}`); }
  }
}

// The origin is the source of truth for messages: members pull its canonical comment set
// (gated by the comment count in the version handshake) and materialise what's missing.
// This is also what relays member comments onward to other member households.
async function pullCanonicalComments(mapping, peer) {
  const target = mapping.remoteMappingId || mapping.remoteAlbumId;
  const sig = { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(target) } };
  const vr = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/version`, { ...sig, signal: AbortSignal.timeout(15000) });
  if (!vr.ok) return;
  const v = await vr.json().catch(() => ({}));
  if (v.comments == null || v.comments === mapping.remoteCommentCount) return;
  const cr = await fetch(`${peer.url}/sidecar/api/v1/albums/${target}/comments`, { ...sig, signal: AbortSignal.timeout(20000) });
  if (!cr.ok) return;
  const { comments = [] } = await cr.json().catch(() => ({}));
  await materialiseComments(mapping, peer.url, peer.name, comments);
  mapping.remoteCommentCount = v.comments; save();
}
// overlap guard: a slow cycle (large albums, slow peers) must not stack concurrent
// full scans — stampedes starve the host Immich's own background jobs.
let WATCH_RUNNING = false;
setInterval(() => {
  if (WATCH_RUNNING) return;
  WATCH_RUNNING = true;
  watchOnce().catch(e => log('watch loop:', e.message)).finally(() => { WATCH_RUNNING = false; });
}, CFG.pollMs);
// comments ride a fast lane: the count statistic is one indexed query, so seconds-level
// cadence stays cheap even on low-power hosts; the full activity fetch only runs on change
setInterval(() => syncComments().catch(e => log('comment loop:', e.message)), Number(process.env.COMMENT_POLL_MS || 5000));

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
  ${state.peers.map(p => `<div class="item"><span>${p.name}</span><span class="muted">${p.url}${p.version ? ` · v${p.version}` : ''}</span></div>`).join('') || '<p class="muted" style="font-size:13px">None yet.</p>'}</div>
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
 button.busy{opacity:.85}
 .spin{display:inline-block;width:14px;height:14px;margin-right:9px;vertical-align:-2px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:isa-spin .8s linear infinite}
 @keyframes isa-spin{to{transform:rotate(360deg)}}
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
 const go=document.getElementById('go');
 go.disabled=true;go.classList.add('busy');
 go.innerHTML='<span class="spin"></span>Joining — syncing photos…';
 const out=document.getElementById('out');out.textContent='';
 const scheme=frag.scheme||'https';
 const r=await fetch('/sidecar/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:scheme+'://'+frag.host+'/share/'+frag.key,forUserId:ME.id})});
 const d=await r.json().catch(()=>({error:'failed'}));
 if(r.ok){
   // album-specific deeplink: the app registers my.immich.app/albums/<id> (the bare
   // list path is NOT registered and falls through to the web fallback)
   var deep='intent://my.immich.app/albums/'+d.albumId+'#Intent;scheme=https;package=app.alextran.immich;S.browser_fallback_url='+encodeURIComponent('https://my.immich.app/albums/'+d.albumId)+';end';
   out.innerHTML='Joined "'+d.album+'" from '+d.from+'.'+(d.permissions==='view'?'<br><span style="font-size:12px">View-only album: you can look and comment, but photos you add stay on your server.</span>':'')+'<br><br>'+
     '<a id="openapp" style="display:inline-block;background:#4250af;color:#fff;text-decoration:none;font-weight:600;padding:12px 30px;border-radius:999px;opacity:.45;pointer-events:none"><span class="spin"></span>Syncing 0/'+d.photos+'…</a>';
   document.getElementById('go').style.display='none';
   // the deeplink only behaves once the album is real and filled — watch it fill live
   var btn=document.getElementById('openapp'), t0=Date.now();
   var ready=function(){btn.innerHTML='Open in Immich app';btn.style.opacity='1';btn.style.pointerEvents='auto';btn.href=deep;};
   if(!d.photos){ready();}
   else{var iv=setInterval(function(){
     fetch('/api/albums/'+d.albumId+'?withoutAssets=true',{credentials:'include'}).then(function(x){return x.json();}).then(function(a){
       var n=a.assetCount||0;
       btn.innerHTML='<span class="spin"></span>Syncing '+Math.min(n,d.photos)+'/'+d.photos+'…';
       if(n>=d.photos||Date.now()-t0>90000){clearInterval(iv);ready();}
     }).catch(function(){if(Date.now()-t0>90000){clearInterval(iv);ready();}});
   },1500);}
 } else { out.textContent='Error: '+(d.error||r.status); go.disabled=false; go.classList.remove('busy'); go.textContent='Accept & join'; }
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
    // Byte interceptors — hotlink model. The app's own asset URLs (thumbnails, video
    // playback, originals) are intercepted for proxy assets and the true bytes stream
    // live from the owner's server (chained for relayed photos). Only a stub is ever
    // stored locally. Falls through to Immich untouched for the user's own assets and
    // on any failure (fail-open).
    const assetHit = u.pathname.match(/^\/api\/assets\/([^/]+)\/(thumbnail|original|video\/playback)$/);
    if (assetHit && req.method === 'GET') {
      const kind = assetHit[2] === 'thumbnail' ? 'preview' : (assetHit[2] === 'original' ? 'original' : 'playback');
      const entry = store.ledgerWithOrigin(assetHit[1]);
      if (entry) {
        // authorise with the caller's OWN credentials: they must be able to see the asset
        const authHeaders: Record<string, string> = {};
        for (const h of ['cookie', 'x-api-key', 'authorization']) if (req.headers[h]) authHeaders[h] = req.headers[h] as string;
        const probe = await fetch(`${CFG.immichUrl}/api/assets/${assetHit[1]}`, { headers: authHeaders });
        if (!probe.ok) { res.writeHead(probe.status); return res.end(); }
        // previews ride the bounded LRU cache: household-wide repeat views skip the
        // cross-server fetch, and recently viewed photos survive owner downtime.
        // Only bytes that truly came FROM THE PEER are ever cached (a local stub
        // fallback must not poison the cache), and hits refresh their LRU slot.
        if (kind === 'preview') {
          const cached = cacheRead(entry.o);
          const baseHeaders = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800, immutable' };
          if (cached) { res.writeHead(200, { ...baseHeaders, 'X-Cache': 'HIT', 'Content-Length': String(cached.length) }); return res.end(cached); }
          const mapping2 = state.mappings.find(mp => mp.id === entry.m);
          const peer2 = mapping2 && state.peers.find(pe => pe.pub === mapping2.peer);
          if (peer2) {
            try {
              const up = await fetch(`${peer2.url}/sidecar/api/v1/assets/${entry.o}/preview`,
                { headers: { 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(entry.o) } });
              if (up.ok) {
                const buf = Buffer.from(await up.arrayBuffer());
                cacheWrite(entry.o, buf);
                res.writeHead(200, { ...baseHeaders, 'Content-Type': up.headers.get('content-type') || 'image/jpeg', 'X-Cache': 'MISS', 'Content-Length': String(buf.length) });
                return res.end(buf);
              }
            } catch (e) { log(`preview fetch failed, serving stub: ${e.message}`); }
          }
          // owner unreachable and nothing cached -> the local stub thumbnail (uncached)
          const stub = await immich(`/assets/${assetHit[1]}/thumbnail?size=preview`).catch(() => null);
          if (stub) { res.writeHead(200, { ...baseHeaders, 'Content-Type': stub.headers.get('content-type') || 'image/jpeg', 'X-Cache': 'BYPASS' }); return res.end(Buffer.from(await stub.arrayBuffer())); }
          res.writeHead(503); return res.end();
        }
        try {
          const out = await fetchTrueBytes(assetHit[1], kind, req.headers.range as string | undefined);
          if (!Array.isArray(out)) {
            const headers: Record<string, string> = {
              'Content-Type': out.headers.get('content-type') || 'application/octet-stream',
              // per-asset bytes never change: let every device cache them hard
              'Cache-Control': 'private, max-age=604800, immutable',
            };
            for (const h of ['content-length', 'content-range', 'accept-ranges']) {
              const v = out.headers.get(h); if (v) headers[h] = v;
            }
            res.writeHead(out.status || 200, headers);
            return Readable.fromWeb(out.body).pipe(res);
          }
        } catch (e) { log(`byte interceptor fell through (${kind}): ${e.message}`); }
      }
      // not a proxy asset / peer unreachable -> Immich serves what it has
    }
    if (!u.pathname.startsWith('/sidecar')) {
      // Transparent proxy to Immich for everything that isn't ours (share pages, their
      // /_app bundles, /api calls). In production Caddy usually routes around us; when the
      // sidecar fronts Immich directly (demo/simple setups) this keeps the SPA fully working.
      // Websocket upgrades can't ride a fetch()-based proxy — refuse cleanly instead of
      // erroring per retry; live web updates need the Immich port (or a real reverse proxy).
      if (req.headers.upgrade) { res.writeHead(426, { 'Content-Type': 'text/plain' }); return res.end('websockets are not proxied here — connect to Immich directly'); }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v; else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      delete headers.host; delete headers['content-length'];
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
    if (u.pathname === '/sidecar/leave' && req.method === 'POST') {
      try { const b = JSON.parse(body); return send(200, await leaveAlbum(b.mappingId)); }
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
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/comments$/)) && req.method === 'GET') {
      const [code, obj] = await handleComments(req, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/nudge$/)) && req.method === 'POST') {
      const [code, obj] = await handleNudge(req, body, m[1]); return send(code, obj);
    }
    const streamOut = (out) => { // stream byte responses through — never buffer (Pi-friendly)
      if (Array.isArray(out)) return send(out[0], out[1]);
      const headers: Record<string, string> = { 'Content-Type': out.headers.get('content-type') || 'application/octet-stream' };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const v = out.headers.get(h); if (v) headers[h] = v;
      }
      res.writeHead(out.status || 200, headers);
      Readable.fromWeb(out.body).pipe(res);
    };
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/original$/))) {
      return streamOut(await handleOriginal(req, m[1]));
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/playback$/))) {
      return streamOut(await handlePlayback(req, m[1]));
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/preview$/))) {
      const out = await handlePreview(req, m[1]);
      if (Array.isArray(out)) return send(out[0], out[1]);
      res.writeHead(200, { 'Content-Type': out.headers.get('content-type') || 'image/jpeg' });
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
    if (u.pathname === '/sidecar/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, household: CFG.name, peers: state.peers.length }));
    }
    send(404, { error: 'not found' });
  } catch (e) { log('http error:', e.message); send(500, { error: e.message }); }
});
server.listen(CFG.port, () => log(`sidecar "${CFG.name}" listening :${CFG.port} — immich: ${CFG.immichUrl}`));
