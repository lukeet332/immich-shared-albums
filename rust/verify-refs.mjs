// rust/verify-refs.mjs — an origin pushes refs to a Rust member sidecar over iroh, and the photo
// becomes a real library row. This is the PUSH half of sync.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(REPO + '/package.json');
const { bindAs, request } = await import(REPO + '/demo/e2e/iroh-client.mjs');
const crypto = await import('node:crypto');

const RUST_DIR = REPO + '/rust';
const DATA_DIR = '/tmp/isa-refs';
const PORT = 9430;
const P2P = 9431;
// The rig's host port map, the same one demo/e2e uses: 2384 here is THIS host's shift, and a
// default checkout (or CI) runs the mocks on 2284-2286.
const PORT = (name, dflt) => process.env[name] || dflt;
const IMMICH = `http://localhost:${PORT('PORT_IMMICH_B', 2284)}`;
const BKEY = fs.readFileSync(REPO + '/demo/.env', 'utf8').match(/^B_API_KEY=(.*)$/m)[1].trim();

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? ' — ' + d : ''}`); };
const delay = ms => new Promise(r => setTimeout(r, ms));

// ---- the origin's identity, so the seeded member recognises it as its linked peer ----
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const originKeys = {
  priv: privateKey.export({ format: 'jwk' }).d,
  pub: publicKey.export({ format: 'jwk' }).x,
};

// ---- seed a member sidecar whose linked peer IS this origin ----
execFileSync('pkill', ['-x', 'isa']).toString?.();
await delay(1500);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
const seeded = JSON.parse(
  execFileSync(`${RUST_DIR}/target/debug/examples/seed_member`, {
    encoding: 'utf8',
    env: { ...process.env, ISA_IMMICH_API_KEY: BKEY, ISA_IMMICH_URL: IMMICH, ISA_DATA_DIR: DATA_DIR,
           ISA_HOUSEHOLD_NAME: 'Member household', PEER_PUB: originKeys.pub },
    cwd: RUST_DIR,
  }).trim().split('\n').pop()
);
check('seeded a member sidecar with a linked peer', !!seeded.albumId, JSON.stringify(seeded));

// ---- run the REAL binary against that state ----
const server = spawn(`${RUST_DIR}/target/debug/isa`, [], {
  env: { ...process.env, ISA_IMMICH_API_KEY: BKEY, ISA_IMMICH_URL: IMMICH, ISA_HOUSEHOLD_NAME: 'Member household',
         ISA_PORT: String(PORT), ISA_P2P_PORT: String(P2P), ISA_DATA_DIR: DATA_DIR, ISA_RELAY: 'false' },
  detached: true, stdio: 'ignore',
});
server.unref();
await delay(4000);

const health = await fetch(`http://localhost:${PORT}/immich-shared-albums/health`).catch(() => null);
check('the member sidecar is up', health?.status === 200);

// ---- learn who to dial, from its own share page ----
const page = await (await fetch(`http://localhost:${PORT}/share/probe`)).text();
const target = JSON.parse(Buffer.from(page.match(/data-origin-endpoint="([^"]+)"/)[1], 'base64url').toString());
target.addrs = [`127.0.0.1:${P2P}`];
check('read the member address from its share page', !!target.pub, target.pub.slice(0, 12) + '…');

process.env.RELAY = 'off';
const ep = await bindAs(originKeys);

const checksum = `refs-verify-${Date.now()}`;
const ref = {
  originAsset: 'origin-asset-refs-probe',
  checksum,
  contributor: { displayName: 'Remote Nan', originUserId: 'remote-person-refs' },
  kind: 'image',
  takenAt: '2026-03-04T05:06:07.000Z',
  exif: { latitude: 48.85, longitude: 2.35, description: 'Pushed by the origin', rating: 5, width: 3000, height: 4000 },
};

// ---- the push ----
const pushed = await request(ep, target.pub, target.addrs, `/albums/${seeded.mappingId}/refs`, { body: { add: [ref] } });
check('the origin pushes a ref and it is accepted', pushed.status === 200, `${pushed.status} ${JSON.stringify(pushed.json)}`);
check('and it reports FULL success, not a partial one', pushed.json?.ok === true, JSON.stringify(pushed.json));
check('with no failed checksums', (pushed.json?.failed || []).length === 0, JSON.stringify(pushed.json?.failed));

// A re-push of the same ref is idempotent: the ledger already has it, so nothing is uploaded twice.
const again = await request(ep, target.pub, target.addrs, `/albums/${seeded.mappingId}/refs`, { body: { add: [ref] } });
check('re-pushing the SAME ref is idempotent', again.status === 200 && again.json?.ok === true, JSON.stringify(again.json));

// ---- what landed ----
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(`${DATA_DIR}/state.db`, { readOnly: true });
const row = db.prepare('SELECT mapping, checksum, localAsset, originAsset, storedFull FROM seen').get();
check('the ledger records the local asset', !!row?.localAsset, row?.localAsset);
check('and remembers the ORIGIN it came from', row?.originAsset === 'origin-asset-refs-probe', row?.originAsset);
check('and marks it a stub, not a full copy', row?.storedFull === 0, String(row?.storedFull));
// TWO different stand-ins are involved, and conflating them is the easy mistake: the HOST
// stand-in owns the mirror ALBUM, while the CONTRIBUTOR stand-in — one per remote person — owns
// the stub ASSET. The stub must belong to the person who took the photo.
const host = db.prepare("SELECT apiKey, userId FROM contributors WHERE slug = 'person-origin-owner-id'").get();
const contributor = db.prepare("SELECT apiKey, userId FROM contributors WHERE slug = 'person-remote-person-refs'").get();
check('a stand-in was provisioned for the remote PERSON', !!contributor?.userId, contributor?.userId?.slice(0, 8));
check('and it is a DIFFERENT account from the album host', contributor?.userId !== host?.userId);

// Read with the CONTRIBUTOR's key: Immich scopes reads per credential, so the album host cannot
// read an asset it does not own.
// Immich fills exifInfo ASYNCHRONOUSLY after an upload, so reading it once races the metadata job
// and reports null dimensions on a fast machine. Wait for the row to carry dimensions, the same way
// verify-bytes does, rather than asserting on whatever happened to be there.
let asset;
let ex = {};
for (let i = 0; i < 40; i++) {
  asset = await (await fetch(`${IMMICH}/api/assets/${row.localAsset}`, { headers: { 'x-api-key': contributor.apiKey } })).json();
  ex = asset.exifInfo || {};
  if (ex.exifImageWidth) break;
  await new Promise(r => setTimeout(r, 500));
}
check('the photo is a real library row', !!asset.id, asset.id?.slice(0, 8));
check('the stub is owned by the CONTRIBUTOR stand-in, not the host and not a human',
  asset.ownerId === contributor.userId,
  `${String(asset.ownerId).slice(0, 8)} vs contributor ${String(contributor.userId).slice(0, 8)}`);
check('kilobyte-sized stub', ex.fileSizeInByte > 0 && ex.fileSizeInByte < 20000, `${ex.fileSizeInByte} bytes`);
check('dimensions from the ref, aspect preserved (3000x4000 -> 192x256)',
  ex.exifImageWidth === 192 && ex.exifImageHeight === 256, `${ex.exifImageWidth}x${ex.exifImageHeight}`);
check('capture date preserved', String(asset.fileCreatedAt).startsWith('2026-03-04'), asset.fileCreatedAt);
check('GPS preserved', ex.latitude === 48.85 && ex.longitude === 2.35, `${ex.latitude},${ex.longitude}`);
check('rating preserved', ex.rating === 5, String(ex.rating));
check('description carries the credit', (ex.description || '').includes('Shared by Remote Nan'), JSON.stringify(ex.description));

// ---- the gates ----
const invented = await request(ep, target.pub, target.addrs, '/albums/no-such-mapping/refs', { body: { add: [ref] } });
check('an unknown mapping answers 404 unknown_mapping', invented.status === 404 && invented.json?.code === 'unknown_mapping', `${invented.status} ${invented.json?.code}`);

try { process.kill(-server.pid); } catch { /* already gone */ }
console.log(`\n${results.every(Boolean) ? '✅ ALL PASS' : '❌ FAILURES'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 1);
