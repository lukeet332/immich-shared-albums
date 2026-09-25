/** e2e/e2e-test.mjs — full-cycle assertion harness: reseed A, reset B, join, contribute, verify. See README.md. */
// Usage: node e2e-test.mjs  (env: AKEY, BKEY, A_URL, B_URL, B_SIDECAR; see run-mock-e2e.sh)
// Every address defaults from the same PORT_* map the rig's composes and runner use, so a shifted
// map — a host that also runs a real Immich — reaches the suite without editing it. The rig's
// compose projects name its containers; RIG_PROJECT_{B,C,D} follow the `name:` in the compose
// files, and every destructive, name-addressed verb below checks that label before acting.
const PORT = (name, dflt) => process.env[name] || dflt;
const RIG_PROJECT = letter => process.env[`RIG_PROJECT_${letter.toUpperCase()}`] || `household-${letter}`;
const RIG_PROJECTS = (process.env.RIG_PROJECTS || 'household-b household-c household-d').split(/\s+/).filter(Boolean);
const A = process.env.A_URL || `http://localhost:${PORT('PORT_IMMICH_C', 2285)}`;
const B = process.env.B_URL || `http://localhost:${PORT('PORT_IMMICH_B', 2284)}`;
const BS = process.env.B_SIDECAR || `http://localhost:${PORT('PORT_SIDECAR_B', 8301)}`;
const AKEY = process.env.AKEY, BKEY = process.env.BKEY;
const ALBUM = process.env.A_ALBUM || '__CREATE__';
// The sidecar's cadence, as the rig actually runs it. `stable()` holds a value for two of these, so
// the hold has to be derived from the same number the sidecars got rather than a literal — with a
// literal, changing the rig's cadence silently leaves every hold-point at the old duration, and an
// experiment that varies the cadence measures nothing. Keep the default in step with
// demo/docker-compose.yml and the household composes.
// Guarded the way the sidecar guards it (src/config.ts envInt: empty → default, below 1000 → refuse):
// an empty or bad value must not become a zero-length hold, which would let every stable() pass on
// its first reading.
const rawPollMs = Number(process.env.ISA_SYNC_POLL_MS);
const SYNC_POLL_MS = Number.isFinite(rawPollMs) && rawPollMs >= 1000 ? rawPollMs : 1000;
/** Two sidecar passes: the smallest window in which "nothing changed" means anything. */
const TWO_CYCLES_MS = 2 * SYNC_POLL_MS;
/** Deadline for a hold: the hold itself plus room for the change to be seen and settle. Derived so
 *  a slower cadence cannot make the deadline shorter than the hold it is supposed to allow. */
const HOLD_DEADLINE_MS = TWO_CYCLES_MS + 25000;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`); };
// Stage boundary. With E2E_FAIL_FAST=1 (CI's default for pull requests) the run stops at the END
// of the first stage that failed a check: the whole stage's evidence is kept — a red check's
// neighbours usually say why — but the ~30 stages after it are not run against a rig that is
// already in a state nobody asserted on. That is what makes a red run take 4 minutes instead
// of 12, and it is why a failing run's later red checks stopped being trustworthy anyway: after
// the first failure they mostly describe the fallout. The summary line still prints, so per-stage
// timing parsers keep working. E2E_FAIL_FAST=0 (a dispatch input in CI) runs everything, for the
// cases where the full failure pattern is the evidence.
const FAIL_FAST = process.env.E2E_FAIL_FAST === '1';
const summary = () => {
  const fails = results.filter(r => !r.ok);
  // ISO-stamped like the stage lines, so the last stage has an end time to close on. A summary
  // without a stamp makes a log undecidable after the fact: the final stage's length can only be
  // guessed from the file's mtime.
  console.log(
    `\n${new Date().toISOString()} ${fails.length === 0 ? '🎉 ALL PASS' : `💥 ${fails.length} FAILURES`} (${results.length} checks)`
  );
  return fails.length;
};
const stage = name => {
  if (FAIL_FAST && results.some(r => !r.ok)) {
    console.log(`\n— stopping before "${name}": E2E_FAIL_FAST=1 and the previous stage failed`);
    summary();
    process.exit(1);
  }
  // ISO-stamped so a local run can be broken down per stage the same way a CI job log is. The
  // stamp is a prefix, so `— stage: <name>` remains what a reader or a grep looks for.
  console.log(`${new Date().toISOString()} — stage: ${name}`);
};
const api = async (base, key, path, init = {}) => {
  const r = await fetch(`${base}/api${path}`, { ...init, headers: { 'x-api-key': key, Accept: 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text().catch(() => '')}`);
  return r.status === 204 ? null : r.json();
};
const j = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
// Bot users live on the project's own email domain — the one check that separates our bots from
// real people, so it must match src/config.ts isUtilityEmail exactly.
// Mirror the runtime's isUtilityEmail: current domain plus the legacy ones it still recognises.
const BOT_DOMAINS = ['immich-shared-albums.internal', 'immich-shared-albums.invalid', 'immich-shared-albums.local', 'sidecar.local'];
const isBot = (e) => !!e && BOT_DOMAINS.some(d => e.endsWith('@' + d));
// /immich-shared-albums/join authenticates the caller against that household's own Immich, so the
// suite has to present a real credential exactly like a signed-in browser would.
const jAuth = (o, key) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(o) });
// Mint a link on the origin and redeem it on B. The join can 401 needsAuth while Immich is
// still churning a prior stage's work (a whoami that times out reads as needsAuth), so this
// retries: the 401 is transient; a real refusal says so in its error text.
const joinWithRetry = async (mintLink) => {
  let out = null;
  for (let attempt = 0; attempt < 4 && !(out && out.album); attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 10000));
    const link = await mintLink();
    const tok = (((await (await fetch(`${ORIGIN_DIRECT}/share/${link.key}`)).text()).match(/data-origin-endpoint="([^"]+)"/) || [])[1]);
    out = await (await fetch(`${BS}/immich-shared-albums/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY }, body: JSON.stringify({ invite: { endpointToken: tok, key: link.key } }) })).json();
  }
  return out;
};
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
/** Wait until Immich has extracted each asset's dimensions, and answer which are still unknown.
 *
 *  A preview can exist while `exifImageWidth` is still null: Immich fills it from the asset's own
 *  metadata on its own schedule. A ref taken inside that window mirrors a square stub FOR EVER — the
 *  ref carries the shape and the ledger marks it delivered — so the mirror-fidelity checks below are
 *  only about the mirror once the origin knows. Slow runner, slow extraction: said as that, not as a
 *  broken mirror. */
const ensureDimensions = async (base, key, ids) => {
  const unknown = new Set(ids);
  for (let i = 0; i < 30 && unknown.size; i++) {
    for (const id of [...unknown]) {
      const exif = ((await api(base, key, `/assets/${id}`)) || {}).exifInfo || {};
      if ((exif.exifImageWidth ?? 0) > 1 && (exif.exifImageHeight ?? 0) > 1) unknown.delete(id);
    }
    if (unknown.size) await sleep(2000);
  }
  return [...unknown];
};
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
// A helper must not be able to kill the run: no out-of-process or network call in this suite
// may throw past its check (see demo/e2e/README.md rule 9).
// Sidecar state is read THROUGH the sidecar's own container — never by opening state.db from the
// host. The database is in WAL mode, and SQLite's WAL protocol relies on POSIX locks to know who
// else has the file open. Across a Docker Desktop bind mount those locks do not reach the VM, so a
// host-side sqlite3 (this suite's old reader, or a curious `sqlite3 state.db`) believes it is the
// LAST connection and deletes state.db-wal/-shm on close. The running sidecar then writes into an
// unlinked WAL forever: every later read — from the host OR from a fresh connection inside the
// container — sees the tables frozen at the last checkpoint, and a restarted sidecar loses
// everything since. Seen 2026-09-18 as `state.db-wal (deleted)` on PID 1's fd table of all three
// rig sidecars; it produced every "local-only" failure this suite ever had (empty peers, a
// missing identity, a kill test whose restarted origin had forgotten its entitlements). A reader
// inside the container is a proper lock participant, so it is safe. Linux bind mounts (CI) share
// the locks and never had the problem — which is why it looked like flakiness instead of a bug.
// Returns the rows as JSON text ('[]' when the query matches nothing), or null when the read
// itself failed (no container, no docker), so a caller can tell "empty" from "unreadable".
import { execFileSync } from 'node:child_process';
const DOCKER_ENV = { ...process.env, PATH: process.env.PATH + ':/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/usr/bin' };
const containerFor = stateDir => {
  const letter = (stateDir.match(/([a-z])-sidecar$/) || [])[1];
  return process.env[`E2E_SIDECAR_CONTAINER_${String(letter).toUpperCase()}`] || `${RIG_PROJECT(letter)}-sidecar-${letter}-1`;
};
// The compose project that owns a container, or '' — the label every name-addressed destructive
// verb checks before acting, so a stale or mistyped name can never reach a container that is not
// this rig's (on a host that also runs a real Immich, that is the production sidecar).
const rigOwns = (container, env) => {
  try {
    const owner = execFileSync('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', container],
                               { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
    return { ok: RIG_PROJECTS.includes(owner), owner };
  } catch { return { ok: false, owner: '(no such container)' }; }
};
const SQLITE_ROWS_JSON =
  'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/state.db",{readOnly:true});' +
  'process.stdout.write(JSON.stringify(db.prepare(process.argv[1]).all()))';
// The Rust sidecar's image has no `node` in it, so reading its state must not go through one. Same
// rule as the shell helper: a throwaway sqlite container on the same Docker host, so the WAL locks
// are shared exactly as they are for the in-container reader. `-readonly` cannot unlink the WAL.
const READER_IMAGE = 'immich-shared-albums:sqlite-reader';
const sidecarDataDir = stateDir => {
  try {
    return execFileSync('docker', ['inspect', '-f',
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', containerFor(stateDir)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: DOCKER_ENV, timeout: 20000 }).trim();
  } catch { return ''; }
};
// Probe for the runtime rather than catching a failure: `docker exec` reports a missing binary on
// STDOUT with status 0, so a catch-based fallback never fires and the error text is parsed as rows.
let nodeInSidecar = null;
const sidecarHasNode = stateDir => {
  if (nodeInSidecar === null) {
    try {
      execFileSync('docker', ['exec', containerFor(stateDir), 'sh', '-c', 'command -v node >/dev/null 2>&1'],
                   { stdio: ['ignore', 'pipe', 'ignore'], env: DOCKER_ENV, timeout: 20000 });
      nodeInSidecar = true;
    } catch { nodeInSidecar = false; }
  }
  return nodeInSidecar;
};
const sidecarSql = (stateDir, sql) => {
  if (sidecarHasNode(stateDir)) {
    try {
      return execFileSync('docker', ['exec', containerFor(stateDir), 'node', '-e', SQLITE_ROWS_JSON, sql],
                          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: DOCKER_ENV, timeout: 20000 }).trim();
    } catch { return null; }
  }
  const src = sidecarDataDir(stateDir);
  if (!src) return null;
  try {
    const out = execFileSync('docker', ['run', '--rm', '-v', `${src}:/data`, READER_IMAGE,
      'sqlite3', '-json', '-readonly', '/data/state.db', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: DOCKER_ENV, timeout: 20000 }).trim();
    return out || null;
  } catch { return null; }
};
const readSidecarKv = (stateDir, name) => {
  const out = sidecarSql(stateDir, `SELECT value FROM kv WHERE name='${name}'`);
  if (!out) return null;
  try { return JSON.parse(JSON.parse(out)[0].value); } catch { return null; }
};
// peers and contributors are real tables since schema v1
/*
 * A stage that cannot read the state it asserts on must not print a line and pass. The suite used
 * to treat an unreadable state.db as an empty one, so `native album invitations` and `a revocation
 * survives content arriving in the same window` could run zero checks and still report green —
 * which silently removes the two stages that cover per-person invitations. `E2E_ALLOW_SKIP=1`
 * keeps the old behaviour for a run that knowingly cannot read host state; otherwise the missing
 * precondition is a failed check, because a green suite that skipped its own coverage is worse than
 * a red one. A failed check, not a throw: a throw here would abort the run, hide every later stage
 * and drop the `N checks)` summary the per-stage timing depends on (README rule 9).
 */
const requireState = what => {
  if (process.env.E2E_ALLOW_SKIP === '1') {
    console.log(`  (skipped: ${what}; E2E_ALLOW_SKIP=1)`);
    return false;
  }
  check(`precondition: ${what}`, false,
        'missing, so this stage ran no checks (E2E_ALLOW_SKIP=1 skips it knowingly; that weakens coverage)');
  return false;
};
const readSidecarPeers = (stateDir) => {
  const out = sidecarSql(stateDir, 'SELECT * FROM peers');
  try { return out ? JSON.parse(out) : null; } catch { return null; }
};
const readSidecarContributors = (stateDir) => {
  const out = sidecarSql(stateDir, 'SELECT * FROM contributors');
  try {
    if (!out) return null;
    return Object.fromEntries(JSON.parse(out).map(({ slug, ...c }) => [slug, c]));
  } catch { return null; }
};
// Rows in the `added` ledger — memberships the sidecar created rather than a human. Security
// property: after unlinking, the memberships left behind must be recorded here.
const readSidecarAdded = (stateDir, albumId) => {
  const sql = albumId
    ? `SELECT COUNT(*) AS n FROM added WHERE al='${albumId}'`
    : 'SELECT COUNT(*) AS n FROM added';
  const out = sidecarSql(stateDir, sql);
  try { return out ? Number(JSON.parse(out)[0].n) : null; } catch { return null; }
};

// Profile every wait: a suite that sleeps blindly cannot be made faster without knowing which
// waits actually cost time and which return immediately. Printed at the end when E2E_PROFILE=1.
const WAITS = [];
const POLL_MS = Number(process.env.E2E_POLL_MS || 1000);
// Interval only: how often we LOOK. Never a budget — see demo/e2e/README.md.
const until = async (fn, timeoutMs = 90000, everyMs = POLL_MS) => {
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < timeoutMs) {
    polls++;
    const v = await fn();
    if (v) {
      WAITS.push({ ms: Date.now() - t0, polls, ok: true });
      return v;
    }
    await sleep(everyMs);
  }
  WAITS.push({ ms: Date.now() - t0, polls, ok: false });
  return null;
};

const stable = async (fn, holdMs, timeoutMs = 60000, everyMs = POLL_MS) => {
  const t0 = Date.now();
  let value = await fn();
  let heldSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(everyMs);
    const next = await fn();
    if (JSON.stringify(next) !== JSON.stringify(value)) {
      value = next;
      heldSince = Date.now();
      continue;
    }
    if (Date.now() - heldSince >= holdMs) {
      WAITS.push({ ms: Date.now() - t0, polls: Math.ceil((Date.now() - t0) / everyMs), ok: true });
      return value;
    }
  }
  WAITS.push({ ms: Date.now() - t0, polls: Math.ceil((Date.now() - t0) / everyMs), ok: false });
  return null; // never held — the assertion that follows reports the real state
};

const waitFor = async (fn, timeoutMs = 20000, everyMs = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
};

let ALBUM_ID = ALBUM;
stage('seed origin album (4 photos, capture dates spread over 4 days)');
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
// The origin has to KNOW each photo's shape before anything mirrors it — see ensureDimensions.
const unknownDims = await ensureDimensions(A, AKEY, aIds);
check("the origin knows each photo's dimensions before anything mirrors them", unknownDims.length === 0,
  unknownDims.length ? `still unknown after 60s: ${unknownDims.join(',')}` : `all ${aIds.length} known`);
await api(A, AKEY, `/assets/${aIds[0]}`, { ...j({ latitude: 51.5074, longitude: -0.1278 }), method: 'PUT' });
{ // give the origin admin a profile picture so avatar-sync has a source
  const fd = new FormData();
  fd.set('file', new Blob([fs.readFileSync(new URL('./fixtures/fx11.jpg', import.meta.url))], { type: 'image/jpeg' }), 'avatar.jpg');
  await fetch(`${A}/api/users/profile-image`, { method: 'POST', headers: { 'x-api-key': AKEY }, body: fd });
}
await api(A, AKEY, `/albums/${ALBUM_ID}/assets`, { ...j({ ids: aIds }), method: 'PUT' });
check('origin album seeded', (await albumAssets(A, AKEY, ALBUM_ID)).length === 4);

stage('create share link + join from B');
let shareKey = (await api(A, AKEY, '/shared-links')).find(l => l.album?.id === ALBUM_ID)?.key;
if (!shareKey) shareKey = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: ALBUM_ID, allowUpload: true }))).key;
// Without Caddy, sidecar and immich are on different ports — the redeem must target the ORIGIN SIDECAR.
const ORIGIN_SIDECAR = process.env.ORIGIN_SIDECAR || A;
// ORIGIN_SIDECAR is resolved by B's sidecar from INSIDE its container (host.docker.internal).
// The security stage calls the origin directly from this process, so it needs a host route.
const ORIGIN_DIRECT = process.env.ORIGIN_SIDECAR_DIRECT || `http://localhost:${PORT('PORT_SIDECAR_C', 8302)}`;

// v2 join body: the origin's share page carries its endpoint token; the invite forwards it.
const inviteFor = async (pageBase, key, extra = {}) => {
  const html = await (await fetch(`${pageBase}/share/${key}`)).text();
  const tok = (html.match(/data-origin-endpoint="([^"]+)"/) || [])[1];
  if (!tok) throw new Error(`share page at ${pageBase} carries no endpoint token`);
  return { invite: { endpointToken: tok, key }, ...extra };
};
const endpointOf = async pageBase => {
  const { invite } = await inviteFor(pageBase, 'probe');
  return JSON.parse(Buffer.from(invite.endpointToken, 'base64url').toString());
};
// One iroh request from INSIDE the rig's network (the host cannot dial container IPs).
const E2E_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
// The probe runs in the sidecar's own image: it already holds the one dependency the probe needs
// (`@number0/iroh`, pinned by the same lockfile the sidecar runs on), so there is no install step.
// It used to run `npm ci` inside a bare node image on every call — ~3.5s of pure overhead per
// probe, seven probes a run — and the rig has already built this image before the suite starts.
// Only demo/e2e is mounted, read-only, so a probe can see nothing but its own client code.
// The INDEPENDENT JavaScript oracle. It must NOT default to the sidecar image: under a Rust sidecar
// that image has no node, and the probe would fail for a reason that looks like a product bug. The
// rig builds a Node image under this tag whatever the sidecar is built from.
const PROBE_IMAGE = process.env.PROBE_IMAGE || 'immich-shared-albums:probe';
// A probe spawns a container and does a live iroh round trip, so it can fail transiently — the
// native addon has been seen to exit on SIGBUS (135) mid-run. That used to throw out of execSync
// and kill the whole suite, hiding every other result behind one flake. Retry once, then report a
// status the checks can fail on, so a probe problem reads as one red check instead of no output.
const irohProbe = (keys, endpoint, path, opts = {}) => {
  const job = JSON.stringify({ keys, peerPub: endpoint.pub, addrs: endpoint.addrs, path, ...opts });
  // ARGV, not a shell string: the job is JSON that no quoting rule survives intact, and a shell is
  // one more thing between the suite and the oracle that can mangle it.
  const argv = [
    'run', '--rm', '--network', 'isa-demo', '-e', 'ISA_ROOT=/app', '-e', 'RELAY=off',
    '-v', `${E2E_DIR}:/probe:ro`, PROBE_IMAGE, 'node', '/probe/probe.mjs', job,
  ];
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync('docker', argv, { timeout: 120000 }).toString().trim().split('\n').pop();
      return JSON.parse(out);
    } catch (e) {
      last = e;
    }
  }
  console.log(`  (probe failed twice: ${String(last?.message).split('\n')[0].slice(0, 80)})`);
  return { status: 0, json: null, probeFailed: true };
};
const joinRes = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, shareKey), BKEY))).json();
check('join succeeded', !!joinRes.album, JSON.stringify(joinRes));
check('join manifest = 4 photos', joinRes.photos === 4, `got ${joinRes.photos}`);

stage('verify mirror on B');
const bAlbums = await api(B, BKEY, '/albums');
const mirror = bAlbums.find(a => a.albumName === joinRes.album && a.assetCount > 0) || bAlbums.find(a => a.albumName === joinRes.album);
check('mirror exists', !!mirror);
const bUsers = await api(B, BKEY, '/admin/users');
const bBotUsers = bUsers.filter(u => isBot(u.email));
const originOwner = await api(A, AKEY, '/users/me');
const originOwnerName = originOwner.name;
// One account per remote person is both the mirror owner and the picker entry, so its display
// name changes when the directory sync lands. Asserting a name here raced; assert the id keying.
const originOwnerEmail = `person-${originOwner.id}@immich-shared-albums.internal`;
const ownerUtility = bBotUsers.find(u => u.email === originOwnerEmail);
check('an account exists for the origin album owner, keyed by their id on their own server',
      !!ownerUtility, bBotUsers.map(u => u.email).join(', '));
check('that account is named for the person', !!ownerUtility && ownerUtility.name.startsWith(originOwnerName),
      ownerUtility?.name || 'no account');
const mirrorAssets = await until(async () => { const x = await albumAssets(B, BKEY, mirror.id); return x.length === 4 ? x : null; });
check('mirror has 4 assets', !!mirrorAssets, mirrorAssets ? '' : 'timed out');
if (mirrorAssets) {
  const humanIds = bUsers.filter(u => !isBot(u.email)).map(u => u.id);
  check('no mirror asset owned by a human on B', mirrorAssets.every(a => !humanIds.includes(a.ownerId)));
  const dates = mirrorAssets.map(a => (a.fileCreatedAt || '').slice(0, 10)).sort();
  check('capture dates preserved (order fix)', JSON.stringify(dates) === JSON.stringify(['2026-08-11','2026-08-12','2026-08-13','2026-08-14']), dates.join(','));
  const withGps = mirrorAssets.find(a => a.exifInfo?.latitude);
  check('GPS location preserved on mirrored photo', !!withGps && Math.abs(withGps.exifInfo.latitude - 51.5074) < 0.001,
        withGps ? `lat=${withGps.exifInfo.latitude}` : 'no GPS on any mirror asset');
  // Avatar sync is best-effort and retried, so a single sample races the retry loop.
  const avatarLanded = await until(async () => {
    const u = (await api(B, BKEY, '/admin/users')).find(x => x.email === originOwnerEmail);
    return u?.profileImagePath ? u : null;
  }, 30000);
  check('origin avatar synced onto utility user', !!avatarLanded, avatarLanded ? 'has avatar' : 'no avatar');
  const originSums = new Set((await albumAssets(A, AKEY, ALBUM_ID)).map(a => a.checksum));
  check('mirrors are light renditions, not byte copies (reference model)', mirrorAssets.every(a => !originSums.has(a.checksum)));
  const stubSizes = mirrorAssets.map(a => (a.exifInfo || {}).fileSizeInByte || 0);
  check('mirrors are kilobyte stubs — hotlink model stores no pixels', stubSizes.every(n => n > 0 && n < 20000),
        stubSizes.join(','));
  // Regression: a mirror stub must carry the origin's ASPECT RATIO, not a fixed 1x1 (which made
  // Immich lay every mirrored photo out square in the grid and letterboxed in the viewer). Compare
  // DISPLAY aspect (orientation applied); mirror dims are capped so allow a small rounding tolerance.
  const dispAspect = a => {
    let w = a.exifInfo?.exifImageWidth ?? 0, h = a.exifInfo?.exifImageHeight ?? 0;
    const o = Number(a.exifInfo?.orientation);
    if (o >= 5 && o <= 8) [w, h] = [h, w];
    return w > 0 && h > 0 ? w / h : 0;
  };
  check('mirror stubs carry real dimensions, not 1x1',
        mirrorAssets.every(a => (a.exifInfo?.exifImageWidth ?? 0) > 1 && (a.exifInfo?.exifImageHeight ?? 0) > 1),
        mirrorAssets.map(a => `${a.exifInfo?.exifImageWidth}x${a.exifInfo?.exifImageHeight}`).join(','));
  const originAspects = (await albumAssets(A, AKEY, ALBUM_ID)).map(dispAspect).sort((x, y) => x - y);
  const mirrorAspects = mirrorAssets.map(dispAspect).sort((x, y) => x - y);
  check('mirror aspect ratios match the origin photos',
        originAspects.length === mirrorAspects.length &&
          originAspects.every((v, i) => Math.abs(v - mirrorAspects[i]) < 0.03),
        `origin=[${originAspects.map(n => n.toFixed(2))}] mirror=[${mirrorAspects.map(n => n.toFixed(2))}]`);
  const gpsProxy = withGps || mirrorAssets[0];
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

stage('a photo Immich has not measured is held back, then arrives shaped');
{
  // The window this stands in for is real — CI hit it once, with a 25-second metadata backlog — and
  // momentary (measured on the rig: dimensions are readable ~50ms after an upload). It is created on
  // purpose here, on the ORIGIN, because that is where refs are built: the sidecar is told to treat
  // one photo as not yet measured.
  const late = await upload(A, AKEY, 'late-e2e.jpg', `late-${Date.now()}`, '2026-08-15T10:00:00.000Z');
  const hide = async (hidden) => (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/test/hide-dimensions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': AKEY },
    body: JSON.stringify({ assetId: late, hidden }) })).json();
  const hiddenOk = (await hide(true)).hidden === true;
  check("the rig can hold one photo's dimensions back from the origin sidecar", hiddenOk);
  await api(A, AKEY, `/albums/${ALBUM_ID}/assets`, { ...j({ ids: [late] }), method: 'PUT' });
  const originWatcherTicks = async () =>
    (await (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/sync/status`, { headers: { 'x-api-key': AKEY } })).json()).ticks.watcher;
  // Cycles, not a sleep: the album has to have been READ while the photo was unmeasured, or the
  // check below would pass on a mirror that simply had not looked yet.
  const ticksBeforeHold = await originWatcherTicks();
  const looked = await until(async () => (await originWatcherTicks()) >= ticksBeforeHold + 3, 30000);
  const held = await albumAssets(B, BKEY, mirror.id);
  check('an unmeasured photo is held back, not mirrored as a square stub',
        !!looked && held.length === 4, `mirror has ${held.length} after ${(await originWatcherTicks()) - ticksBeforeHold} look(s)`);
  check('the photo is in the origin album all the same — held back, not lost',
        (await albumAssets(A, AKEY, ALBUM_ID)).some(a => a.id === late));

  const revealed = (await hide(false)).hidden === false;
  const arrived = await until(async () => {
    const x = await albumAssets(B, BKEY, mirror.id);
    return x.length === 5 ? x : null;
  }, 60000);
  // The cursor must NOT have advanced while the photo waited: if the watcher had stored the album's
  // version on that empty push, nothing would ever offer this photo again and it would never arrive.
  check('once measured it arrives, with real dimensions rather than 1x1',
        revealed && !!arrived && arrived.every(a => (a.exifInfo?.exifImageWidth ?? 0) > 1 && (a.exifInfo?.exifImageHeight ?? 0) > 1),
        arrived ? arrived.map(a => `${a.exifInfo?.exifImageWidth}x${a.exifInfo?.exifImageHeight}`).join(',') : 'never arrived');

  // Leave the album as later stages expect to find it.
  await api(A, AKEY, '/assets', { ...j({ ids: [late], force: true }), method: 'DELETE' });
  await until(async () => (await albumAssets(B, BKEY, mirror.id)).length === 4, 30000);
}

const bAdminName = (await api(B, BKEY, '/users/me')).name;
// One account now represents a remote person for BOTH jobs, so its name depends on what we know:
// "(via <server> server)" once a directory has placed them, "(via shared albums)" until then.
// Match the person, not one naming form — the point is that the account represents that human.
const representsBAdmin = name => !!name && name.startsWith(`${bAdminName} (`);
stage(`B admin contributes 2 photos (old capture dates)`);
const nIds = [];
for (let i = 1; i <= 2; i++) {
  const takenAt = `2026-07-0${i}T09:00:00.000Z`;
  nIds.push(await upload(B, BKEY, `nan-e2e-${i}.jpg`, `nn${i}${Date.now() % 1000}`, takenAt));
}
await ensurePreviews(B, BKEY, nIds);
await api(B, BKEY, `/albums/${mirror.id}/assets`, { ...j({ ids: nIds }), method: 'PUT' });

stage('verify arrival + attribution on A');
const aAfter = await until(async () => { const x = await albumAssets(A, AKEY, ALBUM_ID); return x.length === 6 ? x : null; });
check('A album has 6 assets after contribution', !!aAfter, aAfter ? '' : `still ${(await albumAssets(A, AKEY, ALBUM_ID)).length}`);
if (aAfter) {
  const aUsers = await api(A, AKEY, '/admin/users');
  const nanUser = aUsers.find(u => isBot(u.email) && representsBAdmin(u.name));
  check('contributor utility user exists on A', !!nanUser,
        aUsers.filter(u => isBot(u.email)).map(u => u.name).join(', '));
  const ownerId_A = (await api(A, AKEY, '/users/me')).id;
  const contributed = aAfter.filter(a => !aIds.includes(a.id));
  check('contributions NOT owned by origin admin (timeline clean)', contributed.every(a => a.ownerId !== ownerId_A),
        contributed.map(a => a.ownerId.slice(0, 8)).join(','));
  check('contributions owned by the contributor utility user', nanUser && contributed.every(a => a.ownerId === nanUser.id));
  // POLLED, not sampled: the credit is written by a PUT after the upload, and this read can land
  // between the two — the Rust lane in CI lost that race by 10ms against the TypeScript lane, on the
  // same commit, which is a property of the read and not of either implementation. The assertion is
  // unchanged: BOTH contributed photos must carry the credit, within the window.
  const creditIds = contributed.map(a => a.id);
  const credited = await until(async () => {
    const now = await albumAssets(A, AKEY, ALBUM_ID);
    const mine = now.filter(a => creditIds.includes(a.id));
    return mine.length === creditIds.length &&
      mine.every(a => (a.exifInfo?.description || '').includes('Shared by'))
      ? mine
      : null;
  }, 30000);
  check('uploader credited in photo description', !!credited,
        (credited || contributed).map(a => a.exifInfo?.description || '(none)').join(' | ').slice(0, 80));
  const cDates = contributed.map(a => (a.fileCreatedAt || '').slice(0, 10)).sort();
  check('contribution capture dates preserved', JSON.stringify(cDates) === JSON.stringify(['2026-07-01','2026-07-02']), cDates.join(','));

  stage('stale utility-user display name heals on next sync');
  if (!nanUser) console.log('  (skipped: no contributor account found on A)');
  else {
  await api(A, AKEY, `/admin/users/${nanUser.id}`, { ...j({ name: 'Shared · Legacy Name' }), method: 'PUT' });
  const healId = await upload(B, BKEY, 'heal-e2e.jpg', `hl${Date.now() % 1000}`, '2026-07-03T09:00:00.000Z');
  await ensurePreviews(B, BKEY, [healId]);
  await api(B, BKEY, `/albums/${mirror.id}/assets`, { ...j({ ids: [healId] }), method: 'PUT' });
  const healed = await until(async () => {
    const u = (await api(A, AKEY, '/admin/users')).find(x => x.id === nanUser.id);
    return u && representsBAdmin(u.name) ? u : null;
  }, 60000);
  check('stale utility-user name healed (regression: old "Shared ·" naming)', !!healed,
        healed ? healed.name : 'still stale');
  }
}

stage('A personal timeline must NOT contain B-contributed photos');
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

stage('album People / owners documented in settings');
if (aAfter) {
  // albumUsers is what the app renders under album Options → People
  const albumDetail = await api(A, AKEY, `/albums/${ALBUM_ID}`);
  const memberNames = (albumDetail.albumUsers || []).map(u => u.user?.name).filter(Boolean);
  check('contributor utility user listed as album member on A', memberNames.some(representsBAdmin), memberNames.join(', ') || '(none)');
}

stage('photo ordering matches capture date (newest-first)');
if (aAfter) {
  const ordered = await api(A, AKEY, '/search/metadata', j({ albumIds: [ALBUM_ID], size: 100, order: 'desc' }));
  const dates = ordered.assets.items.map(a => a.fileCreatedAt);
  const sorted = [...dates].sort().reverse();
  check('album assets returned in capture-date order', JSON.stringify(dates) === JSON.stringify(sorted));
}

stage('two-way comment sync');
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

stage('OWNER adds photos post-join -> member receives (owner-perspective sync)');
if (aAfter && mirror) {
  const lateIds = [];
  for (let i = 1; i <= 2; i++) lateIds.push(await upload(A, AKEY, `late-owner-${i}.jpg`, `lo${i}${Date.now() % 10000}`, `2026-06-0${i}T08:00:00.000Z`));
  await ensurePreviews(A, AKEY, lateIds);
  await api(A, AKEY, `/albums/${ALBUM_ID}/assets`, { ...j({ ids: lateIds }), method: 'PUT' });
  const grew = await until(async () => { const x = await albumAssets(B, BKEY, mirror.id); return x.length === 9 ? x : null; });
  check('owner post-join additions reach member mirror (7->9)', !!grew, grew ? '' : `mirror at ${(await albumAssets(B, BKEY, mirror.id)).length}`);
}

stage('same photo shareable into a second album (cross-album dedup bug)');
if (aAfter) {
  const alb2 = (await api(A, AKEY, '/albums', j({ albumName: 'second album' }))).id;
  await api(A, AKEY, `/albums/${alb2}/assets`, { ...j({ ids: [aIds[0]] }), method: 'PUT' });
  const share2 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb2, allowUpload: true }))).key;
  const nanId = (await api(B, BKEY, '/users/me')).id;
  const join2 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, share2, { forUserId: nanId }), BKEY))).json();
  check('second album join ok', join2.photos === 1, JSON.stringify(join2));
  const mirror2 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'second album');
  const m2assets = await until(async () => { const x = await albumAssets(B, BKEY, mirror2.id); return x.length === 1 ? x : null; }, 40000);
  check('previously-shared photo synced into second album', !!m2assets);
  const m2detail = await api(B, BKEY, `/albums/${mirror2.id}`);
  const m2humans = (m2detail.albumUsers || []).filter(u => !isBot(u.user?.email)).map(u => u.user?.id);
  check('private join: only the receiving user among human members', m2humans.length === 1 && m2humans[0] === nanId, `${m2humans.length} human member(s)`);

  stage('re-join by a second user attaches to the existing mirror');
  let second = (await api(B, BKEY, '/admin/users')).find(u => u.email === 'second-e2e@demo.local');
  if (!second) second = await api(B, BKEY, '/admin/users', j({ email: 'second-e2e@demo.local', name: 'Second Human', password: 'e2e-pass-123' }));
  const join2b = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, share2, { forUserId: second.id }), BKEY))).json();
  check('re-join returns the existing mirror (no duplicate album)', join2b.albumId === mirror2.id, JSON.stringify(join2b).slice(0, 100));
  const dupCount = (await api(B, BKEY, '/albums')).filter(a => a.albumName === 'second album').length;
  check('only one "second album" mirror exists', dupCount === 1, `${dupCount} album(s)`);
  const m2after = await api(B, BKEY, `/albums/${mirror2.id}`);
  const m2h2 = (m2after.albumUsers || []).filter(u => !isBot(u.user?.email)).map(u => u.user?.id);
  check('re-join added the second user as member', m2h2.length === 2 && m2h2.includes(second.id), `${m2h2.length} human member(s)`);

  stage('video syncs cross-server as a full original');
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

stage('instant join (no preview wait) heals via reconciliation');
{
  const alb3 = (await api(A, AKEY, '/albums', j({ albumName: 'instant album' }))).id;
  const fresh = await upload(A, AKEY, 'instant-e2e.jpg', `inst${Date.now() % 100000}`, '2026-08-15T09:00:00.000Z');
  await api(A, AKEY, `/albums/${alb3}/assets`, { ...j({ ids: [fresh] }), method: 'PUT' });
  const share3 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb3, allowUpload: true }))).key;
  const meB = (await api(B, BKEY, '/users/me')).id;
  const join3 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, share3, { forUserId: meB }), BKEY))).json();
  check('instant join accepted', !!join3.albumId, JSON.stringify(join3).slice(0, 100));
  const m3 = await until(async () => {
    const mirror3 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'instant album');
    if (!mirror3) return null;
    const x = await albumAssets(B, BKEY, mirror3.id);
    return x.length === 1 ? x : null;
  }, 90000);
  check('photo uploaded seconds before join eventually lands (reconciliation)', !!m3, m3 ? 'landed' : 'timed out');
}

stage('share link created before any photos (empty album) still names the sharer');
{
  const alb5 = (await api(A, AKEY, '/albums', j({ albumName: 'born empty' }))).id;
  const share5 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb5, allowUpload: true }))).key;
  const meB5 = (await api(B, BKEY, '/users/me')).id;
  const join5 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, share5, { forUserId: meB5 }), BKEY))).json();
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

stage('view-only share link (allowUpload off) rejects cross-server uploads');
{
  const alb6 = (await api(A, AKEY, '/albums', j({ albumName: 'view only album' }))).id;
  const voId = await upload(A, AKEY, 'viewonly-e2e.jpg', `vo${Date.now() % 1000}`, '2026-05-01T09:00:00.000Z');
  await ensurePreviews(A, AKEY, [voId]);
  await api(A, AKEY, `/albums/${alb6}/assets`, { ...j({ ids: [voId] }), method: 'PUT' });
  const share6 = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: alb6, allowUpload: false }))).key;
  const meB6 = (await api(B, BKEY, '/users/me')).id;
  const join6 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, share6, { forUserId: meB6 }), BKEY))).json();
  const mirror6 = (await api(B, BKEY, '/albums')).find(a => a.albumName === 'view only album');
  const m6 = await until(async () => { const x = await albumAssets(B, BKEY, mirror6.id); return x.length === 1 ? x : null; }, 60000);
  check('view-only album still syncs for viewing', !!m6, m6 ? '' : 'timed out');
  // Vanilla parity: a view-only share makes the member a VIEWER, so Immich itself refuses a
  // local add — the rogue upload cannot even land in the mirror, a stronger guarantee than
  // the old "adds locally but silently never propagates".
  const rogue = await upload(B, BKEY, 'rogue-e2e.jpg', `rg${Date.now() % 1000}`, '2026-05-02T09:00:00.000Z');
  await ensurePreviews(B, BKEY, [rogue]);
  const addRogue = await fetch(`${B}/api/albums/${mirror6.id}/assets`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY }, body: JSON.stringify({ ids: [rogue] }) });
  const addBody = await addRogue.json().catch(() => []);
  const addedOk = Array.isArray(addBody) && addBody.some(r => r.success);
  check('view-only mirror refuses a local add (member is a viewer, not editor)',
        !addedOk, `status ${addRogue.status}`);
  // Two push cycles with nothing to propagate: require the origin count to HOLD across them
  // rather than trusting one reading after a fixed wait. Runs in ~2 cycles, fails fast if a
  // stray upload ever lands.
  const viewOnlyHeld = await stable(() => albumAssets(A, AKEY, alb6).then(a => a.length), TWO_CYCLES_MS, HOLD_DEADLINE_MS);
  check('view-only album rejects cross-server uploads', viewOnlyHeld === 1,
        `origin held at ${viewOnlyHeld} (want 1)`);
}

stage('a photo owned by a bot account the sidecar has not seen yet is never offered onward');
{
  // Regression for issue #70: the offer filter excludes utility-owned assets by looking the owner
  // up in a cached user list. An owner the cache had never heard of — a bot provisioned seconds
  // ago, a stub from a duplicate materialisation — was treated as a HUMAN, and its stub went to
  // the origin as a fresh contribution: a stub of the origin's own photo, +1 in every household.
  // Here a brand-new utility-domain account (created behind the sidecar's back, so its cache
  // cannot know it) drops a photo into the mirror; the origin's count must hold.
  const originBefore = (await albumAssets(A, AKEY, ALBUM_ID)).length;
  const botEmail = `stub-echo-${Date.now() % 100000}@immich-shared-albums.internal`;
  const botPass = 'e2e-echo-bot-pass-1';
  const bot = await api(B, BKEY, '/admin/users', j({ email: botEmail, name: 'Echo Stub Bot', password: botPass }));
  // Only the mirror's OWNER (a stand-in account) may add members; find its key in B's state.
  let added = false;
  for (const c of Object.values(readSidecarContributors('b-sidecar') || {})) {
    if (!c.apiKey) continue;
    const r = await fetch(`${B}/api/albums/${mirror.id}/users`, { ...j({ albumUsers: [{ userId: bot.id, role: 'editor' }] }), method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-api-key': c.apiKey } });
    if (r.ok) { added = true; break; }
  }
  check('rig: the unknown bot could be made an editor of the mirror', added);
  const login = await (await fetch(`${B}/api/auth/login`, j({ email: botEmail, password: botPass }))).json();
  const botKey = login.accessToken
    ? (await (await fetch(`${B}/api/api-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ name: 'e2e-echo', permissions: ['all'] }) })).json()).secret
    : null;
  check('rig: the unknown bot has a key', !!botKey, botKey ? '' : JSON.stringify(login).slice(0, 80));
  if (added && botKey) {
    const echoId = await upload(B, botKey, 'echo-stub.jpg', `es${Date.now() % 10000}`, '2026-05-05T09:00:00.000Z');
    await api(B, botKey, `/albums/${mirror.id}/assets`, { ...j({ ids: [echoId] }), method: 'PUT' });
    const held = await stable(() => albumAssets(A, AKEY, ALBUM_ID).then(x => x.length), TWO_CYCLES_MS, HOLD_DEADLINE_MS);
    check("a bot-owned photo never reaches the origin, even before the sidecar's user cache knows the bot",
          held === originBefore, `origin ${originBefore} -> held at ${held}`);
    // Leave the album as the suite found it so the later count-based stages are unaffected.
    await api(B, botKey, `/albums/${mirror.id}/assets`, { ...j({ ids: [echoId] }), method: 'DELETE' }).catch(() => {});
  }
}

stage('reverse-direction share — member-owned album with an already-shared photo must not echo');
{
  // regression: a deduped proxy carries ledger rows from several albums/eras; the wire
  // identity must come from the authoritative (materialisation) row or the origin gets
  // its own photo back as a duplicate
  const CS = process.env.C_SIDECAR || `http://localhost:${PORT('PORT_SIDECAR_C', 8302)}`;
  // A URL a SIDECAR is told to fetch: a container name on the shared network, never a host port.
  const REV = process.env.REVERSE_ORIGIN || `http://${RIG_PROJECT('b')}-sidecar-b-1:8300`;
  const albR = (await api(B, BKEY, '/albums', j({ albumName: 'reverse album' }))).id;
  await api(B, BKEY, `/albums/${albR}/assets`, { ...j({ ids: [nIds[0]] }), method: 'PUT' });
  const shareR = (await api(B, BKEY, '/shared-links', j({ type: 'ALBUM', albumId: albR, allowUpload: true }))).key;
  const meC = (await api(A, AKEY, '/users/me')).id;
  const joinR = await (await fetch(`${CS}/immich-shared-albums/join`, jAuth(await inviteFor(BS, shareR, { forUserId: meC }), AKEY))).json();
  check('reverse join: C joins a B-owned album', !!joinR.albumId, JSON.stringify(joinR).slice(0, 100));
  const mirrorR = (await api(A, AKEY, '/albums')).find(a => a.albumName === 'reverse album');
  const mR = mirrorR && await until(async () => { const x = await albumAssets(A, AKEY, mirrorR.id); return x.length === 1 ? x : null; }, 180000);
  check('reverse mirror syncs (dedup reuses the existing proxy)', !!mR, mR ? '' : 'timed out');
  const noEchoHeld = await stable(() => albumAssets(B, BKEY, albR).then(a => a.length), TWO_CYCLES_MS, HOLD_DEADLINE_MS);
  check('already-shared photo does NOT echo back to its owner (regression)', noEchoHeld === 1,
        `B album held at ${noEchoHeld} (want 1)`);
}

stage('third household D joins — member contributions relay through the origin');
const D = process.env.D_URL || `http://localhost:${PORT('PORT_IMMICH_D', 2286)}`;
const DS = process.env.D_SIDECAR || `http://localhost:${PORT('PORT_SIDECAR_D', 8303)}`;
const DKEY = process.env.DKEY;
let dMirror = null;
if (DKEY) {
  const joinD = await (await fetch(`${DS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, shareKey), DKEY))).json();
  check('D join succeeded', !!joinD.albumId, JSON.stringify(joinD).slice(0, 100));
  dMirror = (await api(D, DKEY, '/albums')).find(a => a.albumName === joinD.album);
  const dAssets = await until(async () => { const x = await albumAssets(D, DKEY, dMirror.id); return x.length === 9 ? x : null; }, 150000);
  check('D mirror receives all 9 photos incl. B contributions (relay)', !!dAssets,
        dAssets ? '' : `at ${(await albumAssets(D, DKEY, dMirror.id)).length}`);
  const dUtility = (await api(D, DKEY, '/admin/users')).filter(u => isBot(u.email));
  check('relayed photos attributed to the original contributor on D', dUtility.some(u => representsBAdmin(u.name)),
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

stage('deletion propagation + leave-&-purge (reversible joins)');
{
  const albD = (await api(A, AKEY, '/albums', j({ albumName: 'delete test' }))).id;
  const d1 = await upload(A, AKEY, 'del-1.jpg', `dl1${Date.now() % 1000}`, '2026-04-01T09:00:00.000Z');
  const d2 = await upload(A, AKEY, 'del-2.jpg', `dl2${Date.now() % 1000}`, '2026-04-02T09:00:00.000Z');
  await ensurePreviews(A, AKEY, [d1, d2]);
  await api(A, AKEY, `/albums/${albD}/assets`, { ...j({ ids: [d1, d2] }), method: 'PUT' });
  const shareD = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: albD, allowUpload: true }))).key;
  const meBD = (await api(B, BKEY, '/users/me')).id;
  const joinD2 = await (await fetch(`${BS}/immich-shared-albums/join`, jAuth(await inviteFor(ORIGIN_DIRECT, shareD, { forUserId: meBD }), BKEY))).json();
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
  // The two checks above pass on LOST VISIBILITY alone: once the admin leaves, the mirror is
  // invisible to them whether or not the sidecar purged anything. The ledger is the honest
  // answer - read through the sidecar's container, the same rule as every state read here.
  // The two checks above pass on LOST VISIBILITY alone: once the admin leaves, the mirror is
  // invisible to them whether or not the sidecar purged anything. The sidecar's own /peers view
  // is the honest answer - it reads what the sidecar still holds, not what the admin sees.
  const peersGone = await until(async () => {
    const peers = await (await fetch(`${BS}/immich-shared-albums/peers`, { headers: { 'x-api-key': BKEY } })).json();
    return !(peers.albums || []).some(a => a.name === 'delete test') ? true : null;
  }, 900000);
  check('native leave: the mapping is gone from the sidecar\u2019s own peer view', !!peersGone, peersGone ? '' : 'still in /peers after 15 min');
  // The ledger read through the sidecar's container confirms the DB rows went too.
  const lcLedger = await until(async () => {
    const state = sidecarSql('b-sidecar',
      `SELECT (SELECT COUNT(*) FROM mappings WHERE albumId='${mirrorD.id}') AS mappings,
              (SELECT COUNT(*) FROM seen WHERE mapping IN (SELECT id FROM mappings WHERE albumId='${mirrorD.id}')) AS seen`);
    const parsed = state ? JSON.parse(state)[0] : { mappings: -1, seen: -1 };
    return parsed.mappings === 0 && parsed.seen === 0 ? parsed : null;
  }, 900000);
  const last = (() => {
    const state = sidecarSql('b-sidecar',
      `SELECT (SELECT COUNT(*) FROM mappings WHERE albumId='${mirrorD.id}') AS mappings,
              (SELECT COUNT(*) FROM seen WHERE mapping IN (SELECT id FROM mappings WHERE albumId='${mirrorD.id}')) AS seen`);
    return state ? JSON.parse(state)[0] : { mappings: -1, seen: -1 };
  })();
  check('native leave: the ledger rows are gone (verified through the sidecar\u2019s container)',
        !!lcLedger, lcLedger ? 'mapping rows=0, ledger rows=0' : `still ${last.mappings} mapping(s), ${last.seen} ledger row(s)`);
}

stage('kill test — uncached photos fail closed; cached ones survive from cache');
{
  const all = await albumAssets(B, BKEY, mirror.id);
  const cachedProxy = all.find(a => a.exifInfo?.latitude);          // viewed earlier -> in cache
  const originAll = await albumAssets(A, AKEY, ALBUM_ID);
  const cachedSha = sha1(await fetchBytes(`${A}/api/assets/${aIds[0]}/thumbnail?size=preview`, AKEY));
  // an origin-owned photo that has NEVER been viewed through the interceptor
  const uncachedProxy = all.find(a => !a.exifInfo?.latitude && (a.fileCreatedAt || '').startsWith('2026-08-1'));
  const dockerEnv = { ...process.env, PATH: process.env.PATH + ':/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/usr/bin' };
  // The one name-addressed destructive verb in the suite. On a host that also runs a real
  // sidecar, a stale or mistyped name here would kill THAT — so the container must prove it
  // belongs to one of the rig's compose projects before anything is done to it.
  const ORIGIN_CONTAINER = containerFor('household-c/c-sidecar');
  const owner = rigOwns(ORIGIN_CONTAINER, dockerEnv);
  const isRig = owner.ok;
  check(`rig: ${ORIGIN_CONTAINER} belongs to one of this rig's compose projects`, isRig, `project: ${owner.owner}`);
  // Who the origin IS and WHERE it is, before and after the restart. Recovery can only work if the
  // restarted sidecar comes back with the same iroh identity (its persisted identity) at an address
  // the member can still reach; if either changed, the recovery check's detail says which, so a red
  // run explains itself instead of reading like a transport bug.
  const originWhere = async () => {
    // ARGV, never a shell string: the container name is resolved from this host's compose
    // project, and passing it as one argument is what keeps a name out of shell syntax.
    const sh = argv => { try { return execFileSync('docker', argv, { env: dockerEnv, encoding: 'utf8' }).trim(); } catch (e) { return `? (${String(e.message).split('\n')[0].slice(0, 60)})`; } };
    const ip = sh(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', ORIGIN_CONTAINER]);
    // What the origin holds on disk and what it believes in memory: a restart can only recover if
    // both survived. Sizes of state.db and its WAL, and the origin's own peer list.
    const files = sh(['exec', ORIGIN_CONTAINER, 'sh', '-c', 'ls -l /data | grep state | awk "{print \\$5, \\$9}" | tr "\\n" " "']);
    const peers = await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/peers`, { headers: { 'x-api-key': AKEY } })
      .then(r => r.json()).then(j => (j.peers || []).map(p => `${p.name}:${p.sharedTo ?? '?'}/${p.sharedFrom ?? '?'}`).join(',') || 'none').catch(e => `? ${e.message}`);
    const ep = await endpointOf(ORIGIN_DIRECT).catch(() => null);
    return { pub: ep?.pub ? ep.pub.slice(0, 12) : '?', addrs: ep?.addrs ?? '?', ip, files, peers };
  };
  const before = await originWhere();
  // `kill`, not `stop`: this stage simulates the owner VANISHING, so SIGKILL is the faithful
  // signal and it returns at once. `stop` would additionally wait out the grace period the sidecar
  // now uses to exit cleanly — a graceful exit is covered by a unit test, and paying for it here
  // would only make the crash simulation slower, not more realistic.
  if (isRig) execFileSync('docker', ['kill', ORIGIN_CONTAINER], { env: dockerEnv, stdio: 'ignore' });
  await waitFor(() => {
    try { return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', ORIGIN_CONTAINER], { env: dockerEnv, encoding: 'utf8' }).trim() === 'false'; }
    catch { return true; }
  }, 15000);
  // B may still be tearing down requests to the container we just stopped, so a closed socket
  // here is an expected outcome of this stage — not a reason to abort the whole suite. Treat an
  // unreachable B as the fail-closed answer the check is looking for.
  const deadRes = await fetch(`${BS}/api/assets/${uncachedProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } })
    .catch(() => ({ headers: { get: () => 'BYPROXY' }, arrayBuffer: async () => new ArrayBuffer(0), ok: false }));
  const deadBytes = await deadRes.arrayBuffer();
  check('owner offline: UNCACHED photo cannot be produced (no hidden copy exists)',
        deadRes.headers.get('x-cache') === 'BYPASS' && deadBytes.byteLength < 20000,
        `x-cache: ${deadRes.headers.get('x-cache')}, ${deadBytes.byteLength}B`);
  const cachedRes = await fetch(`${BS}/api/assets/${cachedProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } });
  check('owner offline: recently viewed photo still renders FROM CACHE',
        cachedRes.headers.get('x-cache') === 'HIT' && sha1(await cachedRes.arrayBuffer()) === cachedSha);
  if (isRig) execFileSync('docker', ['start', ORIGIN_CONTAINER], { env: dockerEnv, stdio: 'ignore' });
  // Wait for the thing that restarted — the origin SIDECAR — to answer again, instead of guessing
  // how long a start takes. (This used to ping the origin's Immich, which never went down.)
  await waitFor(async () => (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/health`).catch(() => ({ ok: false }))).ok, 20000);
  const after = await originWhere();
  const aliveRes = await fetch(`${BS}/api/assets/${uncachedProxy.id}/thumbnail`, { headers: { 'x-api-key': BKEY } })
    .catch(() => ({ headers: { get: () => 'UNREACHABLE' }, arrayBuffer: async () => new ArrayBuffer(0), ok: false }));
  check('owner back online: uncached photo streams again (hotlink recovery)',
        aliveRes.headers.get('x-cache') === 'MISS' && (await aliveRes.arrayBuffer()).byteLength > 500,
        `x-cache: ${aliveRes.headers.get('x-cache')}; origin before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
}

stage('loop prevention (the counts must HOLD, not merely read true once)');
// Ping-pong does not show up in a single reading — it shows up as a count that keeps climbing.
// So require every count to be unchanged for two full sync intervals, which is what "2 idle
// watcher cycles" was estimating, and which fails fast if a cycle ever increments anything.
const EXPECT = DKEY ? 10 : 9;
const counts = async () => [
  (await albumAssets(A, AKEY, ALBUM_ID)).length,
  (await albumAssets(B, BKEY, mirror.id)).length,
  ...(DKEY && dMirror ? [(await albumAssets(D, DKEY, dMirror.id)).length] : []),
];
const held = await stable(counts, TWO_CYCLES_MS, HOLD_DEADLINE_MS + 10000);
check('no ping-pong: every count holds for two idle cycles', !!held && held[0] === EXPECT, JSON.stringify(held));

// ─────────────────────────────────────────────────────────────────────────────
// Security regressions. Each check below maps to a specific hole that existed
// before the hardening pass; they are the reason the sidecar is safe to publish
// on a domain rather than only reachable over a tailnet.
// ─────────────────────────────────────────────────────────────────────────────
// Websockets: the sidecar must be able to front Immich on its own, which means carrying
// protocol upgrades. Without this, live web updates silently die in single-front setups —
// invisible to the mobile apps, which is exactly how it went unnoticed before.
// Native invitations: sharing an album by adding a PERSON from a linked server in Immich's OWN
// picker, with no share link involved. The origin detects it by listing albums AS that person's
// marker (which is why this works for albums a non-admin owns), and the member discovers it by
// polling. Sharing is per person: there is deliberately no household-wide stand-in.
stage('native album invitations, per person (no share link)');
{
  const originPeers = readSidecarPeers('household-c/c-sidecar');
  const bPeer = (originPeers || []).find(p => (p.name || '').includes('(B)'));
  // Throws by default; under E2E_ALLOW_SKIP it logs and takes the branch that runs no checks.
  if (bPeer || requireState("the origin's peer record for B")) {
    const bKeys = readSidecarKv('b-sidecar', 'identity');
    const bAdmin = await api(B, BKEY, '/users/me');
    // Markers are identified by display name — exactly how a human picks one in Immich.
    const markerFor = async (person) => (await api(A, AKEY, '/admin/users'))
      .find(u => u.name === `${person} (via ${bPeer.name} server)`);
    const nan = await until(async () => (await markerFor(bAdmin.name)) || null, 90000);
    check('origin created a per-person invite marker for each person on the linked server', !!nan,
          nan ? nan.email : `no user named "${bAdmin.name} (via ${bPeer.name} server)"`);
    check('the marker lives in the per-person namespace, not the contributors one',
          !!nan && nan.email.startsWith('person-'), nan?.email);
    // Sharing is per person. A server link is not a person, so it must not exist as a pickable
    // user at all — managing the link belongs to the panel (see the unlink stage).
    const households = (await api(A, AKEY, '/admin/users')).filter(u => u.email.startsWith('invite-household-'));
    check('no household-wide stand-in exists — a server link is not a person',
          households.length === 0, households.map(u => u.email).join(', '));
    // ONE account per remote person: it owns their photos AND is what a human picks to share
    // with them. Two accounts for one human is the clutter this replaced.
    {
      const all = await api(A, AKEY, '/admin/users');
      const forNan = all.filter(u => isBot(u.email) && (u.name || '').startsWith(bAdmin.name));
      check('one account per remote person, not two', forNan.length === 1,
            forNan.map(u => `${u.name} <${u.email}>`).join(' | '));
    }
    // An invite marker and an attribution contributor can exist for the SAME remote person. If
    // they ever share a display name the two are indistinguishable in the picker.
    {
      const counts = {};
      for (const u of await api(A, AKEY, '/admin/users')) counts[u.name] = (counts[u.name] || 0) + 1;
      const dupes = Object.entries(counts).filter(([, n]) => n > 1);
      check('no two users share a display name (unpickable picker entries)', dupes.length === 0,
            dupes.map(([n, c]) => `${n} x${c}`).join(', '));
    }

    // A narrowed mirror excludes B's admin, so GET /albums as BKEY cannot see it. Look with the
    // stand-in keys that OWN the mirrors — asserting via the admin only proves it was excluded.
    const standInKeys = () => Object.values(readSidecarContributors('b-sidecar') || {})
      .map(c => c && c.apiKey).filter(Boolean);
    /** The MIRRORS among B's albums under a name: the ones a STAND-IN owns. A reunited album belongs
     *  to a human and merely carries our accounts, so counting by what a stand-in can SEE misreads it
     *  as a mirror — which is exactly what a reunion creates. */
    const standInOwnedAlbumIds = async (name) => {
      const ids = new Set();
      for (const k of standInKeys()) {
        const al = await api(B, k, '/albums').catch(() => []);
        for (const a of al || []) {
          if (
            a.albumName === name &&
            (a.albumUsers || []).some(au => au.role === 'owner' && isBot(au.user?.email))
          )
            ids.add(a.id);
        }
      }
      return ids;
    };
    const findOnB = async (name, timeout = 150000) => until(async () => {
      for (const k of standInKeys()) {
        const al = await api(B, k, '/albums').catch(() => []);
        const hit = (al || []).find(a => a.albumName === name);
        if (hit) return { album: hit, key: k };
      }
      return null;
    }, timeout);
    const humansOn = async (found) => {
      const full = await api(B, found.key, `/albums/${found.album.id}?withoutAssets=true`);
      return (full.albumUsers || []).filter(au => !isBot(au.user?.email)).map(au => au.user?.name).sort();
    };

    if (nan) {
      const invAlb = (await api(A, AKEY, '/albums', j({ albumName: 'natively invited album' }))).id;
      const invAsset = await upload(A, AKEY, 'invited.jpg', `inv${Date.now() % 10000}`, '2026-05-01T09:00:00.000Z');
      await ensurePreviews(A, AKEY, [invAsset]);
      await api(A, AKEY, `/albums/${invAlb}/assets`, { ...j({ ids: [invAsset] }), method: 'PUT' });
      // exactly what a human does in the picker
      await api(A, AKEY, `/albums/${invAlb}/users`,
        { ...j({ albumUsers: [{ userId: nan.id, role: 'editor' }] }), method: 'PUT' });
      // 200 is not proof — Immich silently ignores some adds, so read it back
      const back = await api(A, AKEY, `/albums/${invAlb}?withoutAssets=true`);
      check('marker is really a member after the invite',
            (back.albumUsers || []).some(au => au.user?.id === nan.id && au.role === 'editor'));

      // AND IT ARRIVES BECAUSE THE WIRE SAID SO. The rig's cadence is a second, so latency cannot
      // tell a nudge from the sweep — the counter can: the sidecar counts nudges RECEIVED, so this
      // is the assertion that the share reached B as a nudge rather than only as a timer coming
      // round. (What the nudge is worth is measured in the browser lane, where the sweep is slowed
      // to ten minutes and the open page still updates.)
      // No albumId: the counters are process-wide, which is what this needs — the mirror this nudge
      // produces does not exist yet, and B's local album id for it is not the origin's (`invAlb`).
      const nudgesOnB = async () => {
        const r = await fetch(`${BS}/immich-shared-albums/sync/status`, { headers: { 'x-api-key': BKEY } });
        return r.ok ? (await r.json()).nudges : null;
      };
      const nudgesBefore = await nudgesOnB();
      let mirrored = await findOnB('natively invited album');
      check('member mirrors an invited album automatically, with no link', !!mirrored,
            mirrored ? '' : 'timed out');
      const nudgesAfter = await nudgesOnB();
      check('the invitation reached the member as a NUDGE, not only as a sweep',
            !!nudgesBefore && !!nudgesAfter && nudgesAfter.invitations > nudgesBefore.invitations,
            nudgesBefore ? `invitation nudges ${nudgesBefore.invitations} -> ${nudgesAfter?.invitations}` : 'nudges unreadable — is ISA_TEST_HOOKS set on B?');

      // Read the invitation contract HERE, while the invitation is still an ordinary one. This stage
      // goes on to reunite this album, and the origin then legitimately learns about it
      // (`POST /albums/:mappingId/reunified`), so a later read can no longer answer the question the
      // additive rule asks: does an ORDINARY invitation carry no trace of the category?
      const asInvited = irohProbe(bKeys, await endpointOf(ORIGIN_DIRECT), '/invitations');
      const ordinaryInvitation =
        asInvited.status === 200 ? asInvited.json?.invitations || [] : null;
      if (mirrored) {
        const arrived = await until(async () => {
          const x = await albumAssets(B, mirrored.key, mirrored.album.id); return x.length >= 1 ? x : null;
        }, 150000);
        check('invited album\'s photo materialises on the member', !!arrived, arrived ? '' : 'timed out');
        // ── REUNIFY ──────────────────────────────────────────────────────────────────────────
        // The panel's action, end to end: B already holds a partial album of the same name, so it
        // is reunited with the share rather than mirrored into a second album. This is the stage
        // that exercises adoption at all — every check above proves the ordinary flows still work.
        const bOwnBefore = await api(B, BKEY, '/albums', j({ albumName: 'natively invited album' }));
        // POPULATED ON PURPOSE. `j(...)` is a POST, so the line above creates an EMPTY album, and an
        // empty album cannot show that a reunion preserved what was already there — every
        // preservation assertion below would hold trivially, whatever the reunion did to it.
        const bOwnPhoto = await upload(
          B,
          BKEY,
          'b-own.jpg',
          `bown${Date.now() % 10000}`,
          '2026-04-01T09:00:00.000Z'
        );
        await api(B, BKEY, `/albums/${bOwnBefore.id}/assets`, { ...j({ ids: [bOwnPhoto] }), method: 'PUT' });
        const bOwnAssetsBefore = await albumAssets(B, BKEY, bOwnBefore.id);

        // THE PREVIEW the accept page asks before it joins: does this household already own an album
        // of the name the link is for? This is the answer that stops a late reunifier ending up with
        // two albums. It must come back WITHOUT the sidecar redeeming the link — redeeming pins us as
        // a peer on the ORIGIN and writes a mapping there, which opening a page must never do.
        const preview = async (albumName) =>
          (
            await fetch(`${BS}/immich-shared-albums/join/preview`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY },
              body: JSON.stringify({ albumName }),
            })
          ).json();
        const previewHit = await preview('natively invited album');
        check('the accept preview offers the reunion for a name this person already owns',
              previewHit?.reunion?.albumId === bOwnBefore.id, JSON.stringify(previewHit));
        const previewMiss = await preview(`nothing called this ${Date.now()}`);
        check('the accept preview offers nothing for a name they do not own',
              !previewMiss?.reunion, JSON.stringify(previewMiss));
        const previewAnon = await fetch(`${BS}/immich-shared-albums/join/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ albumName: 'natively invited album' }),
        });
        check('the accept preview refuses a caller with no session, like the join it precedes',
              previewAnon.status === 401, `status=${previewAnon.status}`);
        const aBefore = (await albumAssets(A, AKEY, invAlb)).length;

        // The share B holds for this peer, with the local album it currently points at.
        const panel = await (await fetch(`${BS}/immich-shared-albums/me/albums`, {
          headers: { 'x-api-key': BKEY },
        })).json();
        const shared = (panel.albums || []).find(a => a.name === 'natively invited album');
        // The share's own record, so a failure later says WHICH mapping moved and where it pointed.
        const bMappings = sidecarSql('b-sidecar', `SELECT id, role, albumId, remoteAlbumId, remoteMappingId, hostSlug FROM mappings WHERE albumName = 'natively invited album'`);
        console.log(`  (share before reunite: ${JSON.stringify(shared)} mappings=${bMappings})`);
        const bAlbumsNow = await api(B, BKEY, '/albums');
        console.log(`  (B albums named that: ${JSON.stringify(bAlbumsNow.filter(a => a.albumName === 'natively invited album').map(a => ({ id: a.id.slice(0, 8), count: a.assetCount })))})`);

        const reunited = shared
          ? await (await fetch(`${BS}/immich-shared-albums/me/reunite`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY },
              body: JSON.stringify({ mappingId: shared.mappingId, albumName: 'natively invited album' }),
            })).json()
          : null;
        check('B reunites its own album with the share, instead of keeping a second one',
              !!reunited?.album, JSON.stringify(reunited));

        if (reunited?.album) {
          const bOwnAfter = await api(B, BKEY, `/albums/${bOwnBefore.id}`);
          // The whole promise: the reunion ADDS to the album that was already there.
          check('the reunified album is the one B already had, not a new one',
                (bOwnAfter.albumUsers || []).some(au => au.user?.id === bAdmin.id), JSON.stringify(bOwnAfter.albumUsers?.length));
          check("B's own photos are still there, and still B's",
                (await albumAssets(B, BKEY, bOwnBefore.id)).filter(x => x.ownerId === bAdmin.id).length >=
                  bOwnAssetsBefore.filter(x => x.ownerId === bAdmin.id).length,
                `was ${bOwnAssetsBefore.filter(x => x.ownerId === bAdmin.id).length}`);
          // A's photo arrived as a stub: present in B's album, owned by a bot, not by B.
          console.log(
            `  (B polls album ${bOwnBefore.id.slice(0, 8)}; B albums named that: ${JSON.stringify((await api(B, BKEY, '/albums')).filter(a => a.albumName === 'natively invited album').map(a => ({ id: a.id.slice(0, 8), count: a.assetCount })))})`
          );
          const union = await until(async () => {
            const x = await albumAssets(B, BKEY, bOwnBefore.id);
            return x.some(a => a.ownerId !== bAdmin.id) ? x : null;
          }, 120000);
          check("A's photos appear in B's album as stubs, not as B's own",
                !!union, union ? `${union.length} asset(s)` : 'timed out');

          // NO DUPLICATES, and it must HOLD. A second stub for one photo is exactly what
          // album-level suppression prevents, and it shows up the same way the echo does: a count
          // that climbs rather than a single wrong reading. Two peers offering one photo is the
          // 3-household case, so this is the assertion that stops the mesh double-showing.
          const foreignStubs = async () =>
            [(await albumAssets(B, BKEY, bOwnBefore.id)).filter(a => a.ownerId !== bAdmin.id).length];
          const noDupes = await stable(foreignStubs, TWO_CYCLES_MS, HOLD_DEADLINE_MS);
          check("A's photo is in B's album exactly once, across cycles",
                !!noDupes && noDupes[0] === 1, `stub count ${JSON.stringify(noDupes)}`);

          // THE PEOPLE LIST. Who is in the album has to be exactly who should be: the person who
          // owns it, and the accounts we added to carry the other side's photos. This is the
          // assertion behind "the correct people show for all linked servers", and the duplicate
          // check is what catches an account added twice by two different code paths.
          const members = (bOwnAfter.albumUsers || []).map(au => au.user?.id).filter(Boolean);
          check('the reunified album names no account twice',
                members.length === new Set(members).size,
                `${members.length} entries, ${new Set(members).size} distinct`);
          check("the reunified album keeps its owner and adds only our own accounts",
                (bOwnAfter.albumUsers || []).every(au => au.user?.id === bAdmin.id || isBot(au.user?.email)),
                (bOwnAfter.albumUsers || []).map(au => `${au.user?.name}:${au.role}`).join(', '));

          // THE AUDIT TRAIL, and the reason it exists: the two albums were paired by NAME alone, so
          // when the pairing is wrong the people involved are the only ones who can tell — and they
          // can only tell if the album says what happened to it. Exactly ONE line, authored by our
          // bot: a line in the name of the person who clicked would be a comment they never wrote,
          // and a second copy is what a retry loop leaves when idempotency is hoped for rather than
          // recorded.
          const auditLines = async () => {
            const acts = await api(B, BKEY, `/activities?albumId=${bOwnBefore.id}&type=comment`);
            return (acts || []).filter(a => /^Reunited with /.test(a.comment || ''));
          };
          // HELD at one, not merely seen to be one. `until` returns the moment a line exists, so a
          // second copy arriving a cycle later would slip past a single sample — and idempotency is a
          // claim about every retry, which is exactly what `stable` measures.
          const heldAudit = await stable(
            async () => [(await auditLines()).length],
            TWO_CYCLES_MS,
            HOLD_DEADLINE_MS
          );
          const auditFirst = (await auditLines())[0];
          check('the reunion leaves one audit line in the album, authored by our bot',
                !!heldAudit && heldAudit[0] === 1 && isBot(auditFirst?.user?.email),
                `count ${JSON.stringify(heldAudit)} from ${auditFirst?.user?.name ?? 'nobody'}`);

          // THE MERGE REACHES BOTH SIDES. A reunion gives each household the union (design doc §2),
          // so B's own half must arrive on A as stubs — for a long time it did not, because adoption
          // seeded B's whole album as already-sent and A therefore heard about none of it.
          const aAfter = await until(async () => {
            const x = await albumAssets(A, AKEY, invAlb);
            return x.length > aBefore ? x : null;
          }, 120000);
          check("A's album gains B's half — the reunion merged both ways",
                !!aAfter, aAfter ? `${aBefore} -> ${aAfter.length}` : `held at ${aBefore}`);
          // ECHO: and having grown ONCE, it must then HOLD. A ledger that forgets what it sent
          // offers the same photos every cycle, which shows up as a count that keeps climbing.
          const aCounts = async () => [(await albumAssets(A, AKEY, invAlb)).length];
          const held = await stable(aCounts, TWO_CYCLES_MS, HOLD_DEADLINE_MS);
          check("and then stops growing — nothing is offered twice",
                !!held && held[0] === (aAfter?.length ?? aBefore),
                `settled at ${JSON.stringify(held)}, expected ${aAfter?.length ?? aBefore}`);
          // A must hold B's photos as STUBS, not as copies of its own: ownership never moves.
          const aAdminId = (await api(A, AKEY, '/users/me')).id;
          const aUsers = Object.fromEntries((await api(A, AKEY, '/admin/users')).map(u => [u.id, u.email]));
          const aForeign = (await albumAssets(A, AKEY, invAlb)).filter(x => x.ownerId !== aAdminId);
          check("and holds them as stubs, owned by a stand-in rather than by A",
                aForeign.length > 0 && aForeign.every(x => isBot(aUsers[x.ownerId])),
                `${aForeign.length} foreign: ${aForeign.map(x => aUsers[x.ownerId]).join(', ')}`);

          // ── DETACH ─────────────────────────────────────────────────────────────────────────
          // Snapshot, un-reunify, and require the album to be exactly as it was: the assertion that
          // makes name-only matching acceptable.
          const idsBefore = (await albumAssets(B, BKEY, bOwnBefore.id)).map(a => a.id).sort();
          const detached = await (await fetch(`${BS}/immich-shared-albums/me/unreunite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY },
            body: JSON.stringify({ mappingId: shared.mappingId }),
          })).json();
          check('un-reuniting is offered and accepted', !!detached?.left, JSON.stringify(detached));
          const after = await until(async () => {
            const x = await albumAssets(B, BKEY, bOwnBefore.id);
            return x.every(a => a.ownerId === bAdmin.id) ? x : null;
          }, 120000);
          check("un-reuniting removes the other server's photos from the album",
                !!after, after ? '' : 'stubs still present after 120s');
          // Our accounts came off on the way out. They were added on the owner's credential, and
          // only the owner can remove them, so a miss here leaves us reading a private album for
          // good — and makes that album look like a live mirror to anything enumerating by bot key.
          const afterDetach = await api(B, BKEY, `/albums/${bOwnBefore.id}`);
          check('un-reuniting takes our accounts back off the album',
                (afterDetach.albumUsers || []).every(au => !isBot(au.user?.email)),
                (afterDetach.albumUsers || []).map(au => au.user?.name).join(', '));
          // AND IT SAYS SO. The trail is the only record an album carries of what was done to it, and
          // un-reuniting is the event a reader most needs to find: the photos that vanished were
          // removed on purpose. The line has to be written while the bot is still a member, which is
          // between the purge and `stripAlbumBots` — so a line missing here means that window closed.
          const withdrawal = await until(async () => {
            const acts = await api(B, BKEY, `/activities?albumId=${bOwnBefore.id}&type=comment`);
            return (acts || []).find(a => /^Un-reunited with /.test(a.comment || '')) || null;
          }, 30000);
          check('un-reuniting leaves its own line in the album, authored by our bot',
                !!withdrawal && isBot(withdrawal.user?.email),
                withdrawal ? `${withdrawal.user?.name}: ${withdrawal.comment.slice(0, 60)}` : 'no line within 30s');
          check('the album still exists, holding exactly the photos it held before',
                !!after && JSON.stringify(after.map(a => a.id).sort()) === JSON.stringify(bOwnAssetsBefore.map(a => a.id).sort()),
                `before=${bOwnAssetsBefore.length} after=${after?.length}`);
        }

        // Un-reunifying gives the share back as an ORDINARY MIRROR — a new album, created by the
        // member's own invite poll within a tick, because un-reunify never tells the origin to stop
        // offering. The mirror this stage found was retired by the reunion, so re-point `mirrored`
        // once here for every check below. Two traps this resolves without: a NAME search cannot tell
        // that mirror from the album this person owns under the same name — the mirror is the one a
        // STAND-IN owns, and the person's own is owned by a human — and state.db read from the host
        // is a stale snapshot, so the answer comes from the API (README rules 10 and 11).
        const standInOwnedMirror = async () => {
          for (const k of standInKeys()) {
            const al = await api(B, k, '/albums').catch(() => []);
            const hit = (al || []).find(a =>
              a.albumName === 'natively invited album' &&
              (a.albumUsers || []).some(au => au.role === 'owner' && isBot(au.user?.email)));
            if (hit) return { album: hit, key: k };
          }
          return null;
        };
        const remirrored = await until(standInOwnedMirror, 120000);
        if (remirrored) mirrored = remirrored;
        check('un-reunifying gives the share back as a mirror, so the invitation is still live',
              !!remirrored, remirrored ? `mirror ${remirrored.album.id.slice(0, 8)}` : 'no mirror re-created');

        // WAITED FOR, not sampled. The mirror's EXISTENCE and its human membership are two
        // different moments: the sidecar creates the album and then adds the people it is for, so a
        // read taken as soon as the album appears can legitimately find it empty. Sampling once here
        // failed in CI on a freshly re-created mirror, and the same shape of failure appeared
        // locally and was wrongly written off as a flake — which is what a race looks like from the
        // outside when you only ever see it once.
        const invitedOnly = await until(async () => {
          const humans = await humansOn(mirrored).catch(() => []);
          return humans.length === 1 && humans[0] === bAdmin.name ? humans : null;
        }, 60000);
        check('an invite reaches ONLY the invited person',
              !!invitedOnly,
              invitedOnly
                ? invitedOnly.join(', ')
                : `${(await humansOn(mirrored).catch(() => [])).join(', ') || 'nobody yet'} — not just ${bAdmin.name}`);

        // The per-user panel must answer AS the caller. This user belongs to the one album they
        // joined and none of the others the admin can see — so a filtered admin read, which
        // refuses a mirror the admin is not in, can only return the wrong list.
        const login = await fetch(`${B}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'second-e2e@demo.local', password: 'e2e-pass-123' }),
        });
        const loginBody = await login.json().catch(() => ({}));
        const sessionCookie = (login.headers.get('set-cookie') || '').split(';')[0];
        check('the rig can sign a non-admin user in for the panel check',
              login.ok && !!sessionCookie, `${login.status} cookie=${sessionCookie ? 'yes' : 'no'}`);
        const asSecond = await fetch(`${BS}/immich-shared-albums/me/albums`, {
          headers: { Cookie: sessionCookie },
        });
        const secondPanel = await asSecond.json().catch(() => ({}));
        const asAdmin = await fetch(`${BS}/immich-shared-albums/me/albums`, { headers: { 'x-api-key': BKEY } });
        const adminPanel = await asAdmin.json().catch(() => ({}));
        const secondNames = (secondPanel.albums || []).map(a => a.name);
        check('the panel answers the caller, not the admin: the non-admin sees only their own albums',
              asSecond.status === 200 && secondNames.length > 0 && adminPanel.albums.length > secondNames.length,
              `second=${asSecond.status} ${JSON.stringify(secondNames)} vs admin=${adminPanel.albums?.length}`);
        // The page renders itself from the same call: the household to name in its heading, and
        // whether this caller may open the admin panel at all. A link a non-admin cannot follow
        // would bounce them to a sign-in page, so the flag has to be Immich's answer, not a guess.
        // The root is the one URL to remember, so it must not answer an ordinary user with 403 —
        // which is exactly what gating the landing page on admin did. It asks who is calling.
        const root = await fetch(`${BS}/immich-shared-albums/`, { headers: { 'x-api-key': BKEY } });
        const rootHtml = await root.text();
        check('the root answers any signed-in caller instead of refusing a non-admin',
              root.status === 200, `status=${root.status}`);
        // Both documents begin identically (same title, same mount point), so the discriminator is
        // which page's script they load — the panel's own text is rendered client-side and appears
        // in neither.
        check('the root serves the chooser, not one of the panels',
              /assets\/root\.js/.test(rootHtml) && !/assets\/panel\.js/.test(rootHtml),
              `root.js=${/assets\/root\.js/.test(rootHtml)} panel.js=${/assets\/panel\.js/.test(rootHtml)}`);
        // No session at all, which is a different question from the admin link above: the root is
        // public to signed-in people, not to everyone.
        const signedOut = await fetch(`${BS}/immich-shared-albums/`);
        check('the root still refuses someone with no session at all',
              signedOut.status === 401, `status=${signedOut.status}`);
        check('the panel is told the household to name in its heading',
              secondPanel.household === 'Demo household (B)',
              `household=${JSON.stringify(secondPanel.household)}`);
        check('a non-admin is told they are NOT an admin, so the panel offers them no admin link',
              secondPanel.isAdmin === false, `isAdmin=${JSON.stringify(secondPanel.isAdmin)}`);
        check('an admin is told they ARE, so the panel offers the way back to it',
              adminPanel.isAdmin === true, `isAdmin=${JSON.stringify(adminPanel.isAdmin)}`);

        // Reunification matches on the OWNER, and Takeout flattens ownership — the Google Photos
        // importer creates an album per Google album through the importing account's key. So a
        // person's own Takeout half must come back to them as an album THEY own, while an album
        // they were merely added to must not. Both facts come from Immich, never inferred: an
        // album response carries no ownerId, so role inside albumUsers is the only answer.
        const secondUser = (await api(B, BKEY, '/admin/users')).find(u => u.email === 'second-e2e@demo.local');
        // Minted with the login token directly: Immich prefers x-api-key over a bearer, so going
        // through api() (which always sets that header) would authenticate as nobody.
        const secondKey = (await (await fetch(`${B}/api/api-keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginBody.accessToken}` },
          body: JSON.stringify({ name: 'e2e-owned-albums', permissions: ['all'] }),
        })).json()).secret;
        const ownProbe = await api(B, secondKey, '/albums', j({ albumName: 'PROBE the half they brought' }));
        const adminAlbum = await api(B, BKEY, '/albums', j({ albumName: 'PROBE administered by the admin' }));
        await api(B, BKEY, `/albums/${adminAlbum.id}/users`,
              { ...j({ albumUsers: [{ userId: secondUser.id, role: 'editor' }] }), method: 'PUT' });
        const secondAlbums = await api(B, secondKey, '/albums');
        const roleOf = (a, userId) => (a?.albumUsers || []).find(au => au.user?.id === userId)?.role;
        const ownedHalves = secondAlbums.filter(a => roleOf(a, secondUser.id) === 'owner');
        const joinedHalves = secondAlbums.filter(a => roleOf(a, secondUser.id) !== 'owner');
        check('a person\'s own album comes back to them as owner, so it is theirs to offer for reunification',
              roleOf(secondAlbums.find(a => a.id === ownProbe.id), secondUser.id) === 'owner',
              `their own albums: ${ownedHalves.map(a => a.albumName).join(', ') || 'none'}`);
        check('an album they were merely added to is not theirs to offer',
              roleOf(secondAlbums.find(a => a.id === adminAlbum.id), secondUser.id) === 'editor',
              `joined but not owned: ${joinedHalves.map(a => a.albumName).join(', ') || 'none'}`);
      }

      // Withdrawal is asserted against the /invitations CONTRACT rather than state.db: the running
      // process is the authoritative view, and the runner deletes state.db from under a live
      // sidecar during purge, so a host-side file read is not a reliable oracle here.
      const originEp = await endpointOf(ORIGIN_DIRECT);
      const invitations = async () => {
        const r = irohProbe(bKeys, originEp, '/invitations');
        return r.status === 200 ? (r.json?.invitations || []) : null;
      };
      const listedBefore = await invitations();
      check('the invited album is offered on /invitations',
            !!listedBefore?.some(i => i.album?.name === 'natively invited album'),
            JSON.stringify(listedBefore?.map(i => i.album?.name)));
      check('/invitations offers ONLY invitation-shaped shares, never link ones',
            !!listedBefore && listedBefore.every(i => i.album?.name === 'natively invited album'),
            `${listedBefore?.length} entries`);

      // The reunified category is ADDITIVE: absent means "an ordinary share". An ordinary
      // invitation must therefore carry no trace of it — a build that always sent the field would
      // make every share look reunified to a peer that understands it, which is the failure this
      // pins. Read at invitation time (`ordinaryInvitation`), because this stage reunites the album
      // later on and the origin is told.
      check('an ordinary invitation carries no reunified category, so absent still means ordinary',
            !!ordinaryInvitation?.length && ordinaryInvitation.every(i => !('reunified' in i)),
            JSON.stringify(ordinaryInvitation?.map(i => Object.keys(i).sort())));
      // And the present case: after the adoption above, the receiver reports the reunion back, so
      // the ORIGIN's own invitation carries the category — which is what clears its panel row.
      check('a reunited invitation carries the category, so the origin learns it happened',
            !!listedBefore?.some(i => i.album?.name === 'natively invited album' && i.reunified === true),
            JSON.stringify(listedBefore?.map(i => [i.album?.name, i.reunified])));
      check('an invitation names the people it is for, not just the household',
            !!listedBefore?.[0]?.forUserIds?.length, JSON.stringify(listedBefore?.[0]?.forUserIds));

      // TWO people, one album: adding a second person must widen the SAME mirror, not fork it.
      const second = await until(async () => (await markerFor('Second Human')) || null, 90000);
      check('origin has a marker for every person on the linked server, not just the admin', !!second,
            second ? second.email : 'no marker for Second Human');
      if (second && mirrored) {
        await api(A, AKEY, `/albums/${invAlb}/users`,
          { ...j({ albumUsers: [{ userId: second.id, role: 'editor' }] }), method: 'PUT' });
        const widened = await until(async () => {
          const h = await humansOn(mirrored); return h.length === 2 ? h : null;
        }, 120000);
        check('inviting a second person widens the existing mirror', !!widened,
              widened ? widened.join(', ') : (await humansOn(mirrored)).join(', ') || 'timed out');

        // Dropping ONE person while another remains is a revocation for that person only. Without
        // member-side narrowing the sender's action appears to work and silently does nothing.
        await fetch(`${A}/api/albums/${invAlb}/user/${nan.id}`, { method: 'DELETE', headers: { 'x-api-key': AKEY } });
        const narrowed = await until(async () => {
          const h = await humansOn(mirrored);
          return h.length === 1 && h[0] === 'Second Human' ? h : null;
        }, 150000);
        check('de-inviting one person removes only them, and keeps the album for the rest',
              !!narrowed, narrowed ? narrowed.join(', ') : (await humansOn(mirrored)).join(', ') || 'timed out');
        // Across several watcher cycles the mirror must stay exactly one album owned by a
        // stand-in — not a second copy, and not gone. "Several cycles" is a COUNT: the member
        // sidecar counts every evaluation of its watcher and invite loops — at the top of the tick,
        // before any skip, so a settled mapping keeps counting — and the rig exposes that over the
        // hook-gated /sync/status (README rule 10). The 55s sleep this replaces could not tell five
        // cycles from none; waiting until both loops have looked twice more can, and it ends the
        // moment they have. Read the mirror through the API rather than state.db: a member mirror
        // is a real table and the runner's purge rewrites it under the process.
        const ticksOn = async () => {
          const r = await fetch(`${BS}/immich-shared-albums/sync/status?albumId=${mirrored.album.id}`,
                                { headers: { 'x-api-key': BKEY } });
          return r.ok ? (await r.json()).ticks : null;
        };
        const CYCLES_TO_SURVIVE = 2;
        const ticksBefore = await ticksOn();
        const ticksAfter = ticksBefore && await until(async () => {
          const t = await ticksOn();
          return t && t.watcher >= ticksBefore.watcher + CYCLES_TO_SURVIVE
                   && t.invites >= ticksBefore.invites + CYCLES_TO_SURVIVE ? t : null;
        }, 120000);
        check('the member sidecar kept evaluating both loops while the mirror was left alone',
              !!ticksAfter,
              ticksBefore ? JSON.stringify({ before: ticksBefore, after: ticksAfter }) : 'sync/status unreadable — is ISA_TEST_HOOKS set on B?');

        // ── MESH: ONE ALBUM REACHED THROUGH TWO SHARES ───────────────────────────────────────
        // The case album-level suppression exists for. Built from LINK shares on purpose: the
        // invitation stages above revoke their markers and tear those shares down, so a mesh built
        // on invitations would be measuring whatever survived them rather than what it set up.
        // Two same-named albums on the origin, each carrying the SAME asset — Immich lets one asset
        // sit in two albums, so the checksums match without copying any bytes — and B reunites both
        // onto the album it already has. Two mappings then point at one album, both offering it.
        const joinSameNamedShare = async () => {
          const id = (await api(A, AKEY, '/albums', j({ albumName: 'natively invited album' }))).id;
          await api(A, AKEY, `/albums/${id}/assets`, { ...j({ ids: [invAsset] }), method: 'PUT' });
          const key = (await api(A, AKEY, '/shared-links',
            j({ type: 'ALBUM', albumId: id, allowUpload: true }))).key;
          const res = await fetch(`${BS}/immich-shared-albums/join`,
            jAuth(await inviteFor(ORIGIN_DIRECT, key), BKEY));
          const body = await res.json().catch(() => null);
          // CHECKED, not fired and forgotten: an unchecked join is how this stage once reported a
          // mesh it had never managed to build.
          return res.ok && body?.album === 'natively invited album';
        };
        const joined = await joinSameNamedShare();
        const joinedToo = await joinSameNamedShare();
        check('two same-named albums both join as shares of their own', joined && joinedToo,
              `first=${joined} second=${joinedToo}`);

        // Read BOTH before reuniting either: reuniting one retires the mirror it pointed at.
        const twoShares = await until(async () => {
          const list = (await (await fetch(`${BS}/immich-shared-albums/me/albums`, {
            headers: { 'x-api-key': BKEY },
          })).json()).albums?.filter(a => a.name === 'natively invited album') || [];
          return list.length >= 2 ? list : null;
        }, 60000);
        check("the origin's same-named albums reach B as two separate shares",
              !!twoShares, `${twoShares?.length ?? 0} share(s)`);

        let reunions = 0;
        for (const sh of (twoShares || []).slice(0, 2)) {
          const r = await (await fetch(`${BS}/immich-shared-albums/me/reunite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY },
            body: JSON.stringify({ mappingId: sh.mappingId, albumName: 'natively invited album' }),
          })).json();
          if (r?.album) reunions++;
        }
        check('both shares reunite onto the album B already had', reunions === 2, `${reunions} reunited`);

        // The album the reunions land on: the one B OWNS under that name, which a stand-in cannot be
        // — re-resolved here rather than captured above, because the block that captured it is not
        // in scope at this point in the lane.
        const ownAlbum = (await api(B, BKEY, '/albums')).find(
          a => a.albumName === 'natively invited album' &&
               (a.albumUsers || []).some(au => au.user?.id === bAdmin.id && au.role === 'owner')
        );
        check('the reunions landed on the album B owns', !!ownAlbum, ownAlbum?.id?.slice(0, 8) ?? 'not found');

        // THE ASSERTION: two mappings offered this photo into one album, so it holds it ONCE.
        // Without album-level suppression each mapping materialises its own stub, and Immich cannot
        // collapse them — the bytes differ by a random tail precisely so each is a distinct asset.
        const oneOfIt = await until(async () => {
          const x = await albumAssets(B, BKEY, ownAlbum.id);
          return x.filter(a => a.ownerId !== bAdmin.id).length === 1 ? x : null;
        }, 120000);
        const stubsNow = (await albumAssets(B, BKEY, ownAlbum.id)).filter(a => a.ownerId !== bAdmin.id).length;
        check('two shares offering one photo leave ONE copy, not two', !!oneOfIt, `${stubsNow} stub(s)`);

        const mirrorAlbumIds = await standInOwnedAlbumIds('natively invited album');
        const survivors = await until(async () => {
          const h = await humansOn(mirrored);
          return h.length === 1 && h[0] === 'Second Human' ? h : null;
        }, 30000);
        check('a non-admin-only invitation keeps one live mirror across watcher cycles',
              mirrorAlbumIds.size === 1 && !!survivors && !!ticksAfter,
              JSON.stringify({ albumIds: [...mirrorAlbumIds], humans: survivors, cyclesSurvived: ticksAfter ? CYCLES_TO_SURVIVE : 'unproven' }));
        await fetch(`${A}/api/albums/${invAlb}/user/${second.id}`, { method: 'DELETE', headers: { 'x-api-key': AKEY } });
      } else {
        await fetch(`${A}/api/albums/${invAlb}/user/${nan.id}`, { method: 'DELETE', headers: { 'x-api-key': AKEY } });
      }

      const retired = await until(async () => {
        const list = await invitations();
        return list && !list.some(i => i.album?.name === 'natively invited album') ? true : null;
      }, 90000);
      check('withdrawing the invite stops it being offered', !!retired, retired ? '' : 'still offered');

      // and the member must not be left holding a stale album of placeholders
      const mirrorGone = await until(async () => {
        const ids = await standInOwnedAlbumIds('natively invited album');
        return ids.size === 0 ? true : null;
      }, 120000);
      check('member tears down its mirror when the last invitee is removed', !!mirrorGone,
            mirrorGone ? '' : 'stale mirror still present');

      // REGRESSION (run12): B must never read its OWN mirror as an invitation it received.
      // Nothing at B ever invites C in this suite, so any owner+invite mapping on B is bogus.
      // It happened because one stand-in was both C's invitation marker and C's attribution
      // contributor: the sidecar added it to B's mirror as editor, B's detector called that an
      // invitation, offered C a mirror of C's own album, and the two ping-ponged every 8s.
      const bMappings = readSidecarKv('b-sidecar', 'mappings') || [];
      const bogus = bMappings.filter(m => m.role === 'owner' && m.via === 'invite');
      check('member never mistakes its own mirror for an invitation (no ping-pong)',
            bogus.length === 0, bogus.map(m => `${m.albumName}`).join(', ') || '');
    }
  }
}

// THE RACE the `added` ledger exists to close. One account now serves both jobs, so after a human
// revokes, the sidecar may still materialise an arriving photo into that album and re-add the
// person for attribution. If that re-add were mistaken for a fresh invitation, the revocation
// would silently never happen — the worst failure mode in this project, because it looks like it
// worked. Recording our own additions is what makes the human's removal win.
//
// A 20s poll race cannot be forced deterministically, so this is built to prove the mechanism and
// never fail falsely: it drives content at the album immediately after revoking, then asserts the
// withdrawal happened anyway. If the re-add did land it proves the ledger; if it did not, the
// withdrawal assertion still holds.
stage('a revocation survives content arriving in the same window');
{
  const originPeers = readSidecarPeers('household-c/c-sidecar');
  const bPeer = (originPeers || []).find(p => (p.name || '').includes('(B)'));
  const bAdmin2 = await api(B, BKEY, '/users/me');
  const nan =
    bPeer &&
    (await api(A, AKEY, '/admin/users')).find(
      u => isBot(u.email) && (u.name || '').startsWith(`${bAdmin2.name} (`)
    );
  if (nan || requireState("an account representing B's admin on the origin")) {
    const raceAlb = (await api(A, AKEY, '/albums', j({ albumName: 'race album' }))).id;
    const rAsset = await upload(A, AKEY, 'race.jpg', `rc${Date.now() % 10000}`, '2026-03-01T09:00:00.000Z');
    await ensurePreviews(A, AKEY, [rAsset]);
    await api(A, AKEY, `/albums/${raceAlb}/assets`, { ...j({ ids: [rAsset] }), method: 'PUT' });
    await api(A, AKEY, `/albums/${raceAlb}/users`,
      { ...j({ albumUsers: [{ userId: nan.id, role: 'editor' }] }), method: 'PUT' });

    const standInKeys = () =>
      Object.values(readSidecarContributors('b-sidecar') || {})
        .map(c => c && c.apiKey)
        .filter(Boolean);
    const mirroredRace = await until(async () => {
      for (const k of standInKeys()) {
        const al = await api(B, k, '/albums').catch(() => []);
        const hit = (al || []).find(a => a.albumName === 'race album');
        if (hit) return { album: hit, key: k };
      }
      return null;
    }, 150000);
    check('race setup: the invited album mirrored on the member', !!mirroredRace,
          mirroredRace ? '' : 'timed out');

    if (mirroredRace) {
      // The withdrawal is news too, and the same counter proves it travelled as one: sample before
      // the removal, assert after it that B heard about it over the wire rather than at its sweep.
      const raceNudgesBefore = await (await fetch(`${BS}/immich-shared-albums/sync/status`,
        { headers: { 'x-api-key': BKEY } })).json().then(r => r.nudges).catch(() => null);
      // Revoke, then IMMEDIATELY give the origin something to materialise into that same album.
      await fetch(`${A}/api/albums/${raceAlb}/user/${nan.id}`, {
        method: 'DELETE',
        headers: { 'x-api-key': AKEY },
      });
      const pushId = await upload(B, BKEY, 'race-push.jpg', `rp${Date.now() % 10000}`, '2026-03-02T09:00:00.000Z');
      await ensurePreviews(B, BKEY, [pushId]);
      await api(B, mirroredRace.key, `/albums/${mirroredRace.album.id}/assets`,
        { ...j({ ids: [pushId] }), method: 'PUT' }).catch(() => {});

      const originEp2 = await endpointOf(ORIGIN_DIRECT);
      const invitations = async () => {
        const bKeys2 = readSidecarKv('b-sidecar', 'identity');
        const r = irohProbe(bKeys2, originEp2, '/invitations');
        return r.status === 200 ? (r.json?.invitations || []) : null;
      };
      const withdrawn = await until(async () => {
        const list = await invitations();
        return list && !list.some(i => i.album?.name === 'race album') ? true : null;
      }, 150000);
      check('the revocation still wins when a photo arrives in the same window', !!withdrawn,
            withdrawn ? '' : 'still offered — a sidecar re-add was read as a fresh invitation');
      const raceNudgesAfter = await (await fetch(`${BS}/immich-shared-albums/sync/status`,
        { headers: { 'x-api-key': BKEY } })).json().then(r => r.nudges).catch(() => null);
      check('a withdrawn invitation is pushed too, not waited out',
            !!raceNudgesBefore && !!raceNudgesAfter && raceNudgesAfter.invitations > raceNudgesBefore.invitations,
            raceNudgesBefore ? `invitation nudges ${raceNudgesBefore.invitations} -> ${raceNudgesAfter?.invitations}` : 'nudges unreadable');

      const raceGone = await until(async () => {
        for (const k of standInKeys()) {
          const al = await api(B, k, '/albums').catch(() => []);
          if ((al || []).some(a => a.albumName === 'race album')) return null;
        }
        return true;
      }, 150000);
      check('the member tears the mirror down despite the arriving content', !!raceGone,
            raceGone ? '' : 'stale mirror survived the revocation');

      // Mechanism, not timing: if the sidecar did re-add during the window it must be recorded.
      // The sidecar no longer writes membership on an invitation album at all — an invited
      // person's membership is the human's, so a missing one is a revocation, not a gap to fill.
      // Zero rows here is therefore the CORRECT state, not an unexercised race.
      const rows = readSidecarAdded('household-c/c-sidecar', raceAlb);
      check(
        'the sidecar never wrote membership on the invitation album',
        rows === null || rows === 0,
        rows === null ? 'state.db unreadable' : `${rows} row(s) — it should never write here`
      );
    }
  }
}

// The album index a linked peer reads to find the other half of a split album. The sidecar cannot
// enumerate a human's albums itself — GET /albums is scoped to one credential and the sidecar holds
// none for a person — so a person's own panel reports them and this records that. Ownership is
// therefore settled at publication time, which is the fact this stage pins from both sides.
stage('album index: what a person offered for matching, recorded only for the peer it was offered to');
{
  const linkedPeer = String(readSidecarPeers('b-sidecar')?.[0]?.pub || '');
  if (!linkedPeer) requireState("B's peer list from demo/b-sidecar/state.db");

  if (linkedPeer) {
    // Asserts the rows the /albums WIRE route reads — handlePublishedAlbums returns exactly these —
    // without dialling: a cross-container iroh dial here is a harness concern, and the transport
    // has its own coverage in the entitlement and probe stages.
    const storedIndex = () =>
      JSON.parse(
        sidecarSql(
          'b-sidecar',
          `SELECT ownerUserId, name FROM published_albums WHERE peer = '${linkedPeer}' ORDER BY name`
        ) || '[]'
      );

    const before = storedIndex();
    check('the album index starts empty, so nothing is offered before a person publishes',
          Array.isArray(before) && before.length === 0, JSON.stringify(before));

    // Published as a real person: this non-admin owns an album, so the panel route records it.
    // Their key is minted from a login token directly — Immich prefers x-api-key over a bearer,
    // so api() would authenticate as nobody.
    const ownerTok = (await (await fetch(`${B}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'second-e2e@demo.local', password: 'e2e-pass-123' }),
    })).json()).accessToken;
    const ownKey = (await (await fetch(`${B}/api/api-keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerTok}` },
      body: JSON.stringify({ name: 'e2e-index-owner', permissions: ['all'] }),
    })).json()).secret;
    const ownAlbum = await api(B, ownKey, '/albums', j({ albumName: 'PROBE my takeout half' }));
    const ownList = await api(B, ownKey, '/albums');
    const meSecond = await (await fetch(`${B}/api/users/me`, { headers: { 'x-api-key': ownKey } })).json();
    check('the rig has a non-admin who owns an album of their own to offer',
          !!ownAlbum?.id && ownList.some(a => a.id === ownAlbum.id), `albums=${ownList.length}`);

    const routeCall = (body, key = ownKey) => fetch(`${BS}/immich-shared-albums/me/albums/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

    const ownedNames = ownList
      .filter(a => (a.albumUsers || []).some(au => au.role === 'owner' && au.user?.id === meSecond.id))
      .map(a => a.albumName)
      .sort();

    const offered = await routeCall({ peer: linkedPeer });
    const after = storedIndex();
    check(
      "the index is what IMMICH says the caller owns, not what the request claimed",
      offered.status === 200 &&
        JSON.stringify(after.map(a => a.name).sort()) === JSON.stringify(ownedNames),
      `status=${offered.status} published=${offered.json?.published} stored=${JSON.stringify(after.map(a => a.name).sort())} owned=${JSON.stringify(ownedNames)}`
    );
    check('the index names the album OWNER, which is what routes a repair request owner-to-owner',
          !!after.length && after.every(a => a.ownerUserId === meSecond.id),
          JSON.stringify(after.map(a => ({ name: a.name, mine: a.ownerUserId === meSecond.id }))));

    // A body cannot add an album or name someone else's: the list is read from Immich on the
    // caller's own credential, so this must change nothing at all.
    await routeCall({
      peer: linkedPeer,
      albums: [{ albumName: 'claimed but not owned', albumUsers: [{ user: { id: 'someone-else', name: 'X' }, role: 'owner' }] }],
    });
    check('an album the caller does not own cannot be injected through the request body',
          !storedIndex().find(a => a.name === 'claimed but not owned'),
          `names=${JSON.stringify(storedIndex().map(a => a.name))}`);

    // The peer has to be linked: a pubkey this household has no relationship with is refused.
    const stranger = await routeCall({ peer: 'not-a-linked-peer' });
    check('publishing to a server this household is not linked to is refused',
          stranger.status === 404, `status=${stranger.status} ${JSON.stringify(stranger.json)}`);
  }
}


// Matching, end to end across two servers. Both sides publish their OWN albums over the new
// /albums route, and each panel then pairs the halves by name and owner. This is the first test
// that exercises the wire read in the direction it was built for — B publishing to C and C
// reading B's index, which a probe container could not dial.
stage('reunification matching: two servers each find the other half of an album');
{
  const bPeerPubs = (readSidecarPeers('b-sidecar') || []).map(p => p.pub);
  const cPeers = readSidecarPeers('c-sidecar') || [];
  const cPub = bPeerPubs[0];
  const bPub = (cPeers.find(p => bPeerPubs.includes(p.pub)) || {}).pub || (cPeers[0] || {}).pub;
  if (!cPub || !bPub) requireState("both sides' peer lists from their state.db");

  if (cPub && bPub) {
    const aMe = await api(A, AKEY, '/users/me');
    const aAlbums = await api(A, AKEY, '/albums');
    const aOwned = aAlbums.find(x => (x.albumUsers || []).some(au => au.role === 'owner' && au.user?.id === aMe.id));
    const bOwned = (await api(B, BKEY, '/albums')).find(x => (x.albumUsers || []).some(au => au.role === 'owner'));

    // A pair to find: the SAME name on both sides, owned by their respective admins.
    const named = `Reunion probe ${Date.now() % 100000}`;
    await api(B, BKEY, '/albums', j({ albumName: named }));
    await api(A, AKEY, '/albums', j({ albumName: named }));
    check('the rig has a same-named album owned on each side to match',
          !!aOwned && !!bOwned, `C-owned=${!!aOwned} B-owned=${!!bOwned}`);

    const publish = async (sidecar, img, key, peerPub) =>
      (await (await fetch(`${sidecar}/immich-shared-albums/me/albums/publish`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ peer: peerPub }),
      })).json()).published;

    const bPublished = await publish(BS, B, BKEY, cPub);
    const cSidecar = process.env.C_SIDECAR || `http://localhost:${PORT('PORT_SIDECAR_C', 8302)}`;
    const cPublished = await publish(cSidecar, A, AKEY, bPub);
    check('each side offers its own albums to the other for matching',
          bPublished > 0 && cPublished > 0, `B offered ${bPublished}, C offered ${cPublished}`);

    // C published to B and B published to C, so reading the other's index over iroh is now the
    // ordinary path rather than a harness stunt.
    // The sidecar's own route, not Immich's: api() prefixes /api and would 404.
    const sidecarGet = (base, key, path) =>
      fetch(`${base}${path}`, { headers: { 'x-api-key': key } }).then(async r => {
        if (!r.ok) throw new Error(`${path} -> ${r.status}`);
        return r.json();
      });
    const bMatches = await sidecarGet(BS, BKEY, '/immich-shared-albums/me/matches');
    const cMatches = await sidecarGet(cSidecar, AKEY, '/immich-shared-albums/me/matches');
    const findPair = (matches, owner) =>
      (matches || []).find(m => m.mine.name === named && m.theirs.ownerName === owner);
    const bFound = findPair(bMatches.matches, aMe.name);
    const cFound = findPair(cMatches.matches, (await api(B, BKEY, '/users/me')).name);
    check('B finds its half of the album in the other server\'s index',
          !!bFound, `matches=${JSON.stringify((bMatches.matches || []).map(m => `${m.mine.name}<>${m.theirs.name}`).slice(0, 5))}`);
    check('the match is symmetric: each side sees the pair, independently',
          !!bFound && !!cFound, `B=${!!bFound} C=${!!cFound}`);
    check('a match names whose server the other half is on, for the owner-to-owner request',
          !!bFound && bFound.peer === cPub && !!bFound.peerName,
          bFound ? `peer=${bFound.peerName}` : 'no match');
  }
}

// The panel's Invite, end to end. It is the ONE sharing act the sidecar performs for a human, so it
// is pinned where it would do damage: a request must not be able to share an album the caller does
// not own, nor reach a person the peer never named. The invitation then travels the ordinary
// channel, and the fact comes back over the wire so the inviter's own list clears.
stage('panel invite: the panel shares the album, the other side accepts');
{
  const bPeerPubs = (readSidecarPeers('b-sidecar') || []).map(p => p.pub);
  const cPeers = readSidecarPeers('c-sidecar') || [];
  const cPub = bPeerPubs[0];
  const bPub = (cPeers.find(p => bPeerPubs.includes(p.pub)) || {}).pub || (cPeers[0] || {}).pub;
  if (!cPub || !bPub) requireState("both sides' peer lists from their state.db");

  if (cPub && bPub) {
    const cSidecar = process.env.C_SIDECAR || `http://localhost:${PORT('PORT_SIDECAR_C', 8302)}`;
    const name = `Invite probe ${Date.now() % 100000}`;
    const bAlbum = await api(B, BKEY, '/albums', j({ albumName: name }));
    await api(A, AKEY, '/albums', j({ albumName: name }));
    const aMe = await api(A, AKEY, '/users/me');
    const bMe = await api(B, BKEY, '/users/me');

    // A panel visit publishes before it can invite, and the invite is checked against what the peer
    // published: that is how the operation refuses a pairing the other side never offered. The lane
    // has to do the same thing a panel does, or it is testing a request no UI would ever make.
    const publishTo = (sidecar, key, peerPub) =>
      fetch(`${sidecar}/immich-shared-albums/me/albums/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ peer: peerPub }),
      }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
    const offered = [await publishTo(BS, BKEY, cPub), await publishTo(cSidecar, AKEY, bPub)];
    check('both sides offered their albums first, as a panel visit does',
          offered.every(o => o.status === 200),
          JSON.stringify(offered.map(o => `${o.status}:${o.json?.published}`)));

    const invite = (sidecar, key, body) =>
      fetch(`${sidecar}/immich-shared-albums/me/invite`, jAuth(body, key)).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
    const matchesFor = async (sidecar, key, ownerName) =>
      (await (await fetch(`${sidecar}/immich-shared-albums/me/matches`, { headers: { 'x-api-key': key } })).json()).matches
        .find(m => m.mine.name === name && m.theirs.ownerName === ownerName);

    const notMine = await invite(BS, BKEY, { peer: cPub, albumName: `${name} (not mine)`, ownerUserId: aMe.id });
    check('an invite for an album the caller does not own is refused', notMine.status === 400,
          `status=${notMine.status} ${JSON.stringify(notMine.json)}`);
    const stranger = await invite(BS, BKEY, { peer: 'not-a-linked-peer', albumName: name, ownerUserId: aMe.id });
    check('an invite to a server this household is not linked to is refused', stranger.status === 404,
          `status=${stranger.status}`);

    const invited = await invite(BS, BKEY, { peer: cPub, albumName: name, ownerUserId: aMe.id });
    check('the invite is accepted for the caller\'s own album and that person', invited.status === 200,
          `status=${invited.status} ${JSON.stringify(invited.json)}`);
    const shared = await api(B, BKEY, `/albums/${bAlbum.id}?withoutAssets=true`);
    const members = (shared.albumUsers || []).map(au => `${au.user && au.user.name}:${au.role}`);
    check('and it is a real membership on the album in Immich, added as the caller',
          (shared.albumUsers || []).some(au => au.user && au.user.id !== bMe.id && au.role === 'editor'),
          `albumUsers=${JSON.stringify(members)}`);

    const waiting = await matchesFor(BS, BKEY, aMe.name);
    check("the inviter's row now waits instead of offering the button again",
          !!waiting && waiting.step && waiting.step.kind === 'waiting',
          `step=${JSON.stringify(waiting && waiting.step)}`);

    let accept = null;
    for (let waited = 0; waited < HOLD_DEADLINE_MS && !accept; waited += SYNC_POLL_MS) {
      const m = await matchesFor(cSidecar, AKEY, bMe.name);
      if (m && m.step && m.step.kind === 'accept' && m.mappingId) accept = m;
      else await sleep(SYNC_POLL_MS);
    }
    check('the other side is offered an invitation it can accept', !!accept,
          accept ? `mapping=${String(accept.mappingId).slice(0, 8)}` : 'no accept step appeared');

    if (accept) {
      const taken = await fetch(`${cSidecar}/immich-shared-albums/me/reunite`, jAuth({ mappingId: accept.mappingId, albumName: name }, AKEY));
      check('accepting it reunites the pair', taken.ok, `status=${taken.status} ${JSON.stringify(await taken.json().catch(() => null))}`);

      let cleared = false;
      for (let waited = 0; waited < HOLD_DEADLINE_MS && !cleared; waited += SYNC_POLL_MS) {
        cleared = !(await matchesFor(BS, BKEY, aMe.name));
        if (!cleared) await sleep(SYNC_POLL_MS);
      }
      check("the inviter's list stops offering the pair, told over the wire", cleared,
            cleared ? '' : 'the row survived the reunion');
    }
  }
}

stage('route prefix rename + legacy compatibility');
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

  // the share page serves OUR document (join card over the framed native page) — the discovery surface
  const shell = await (await fetch(`${BS}/share/e2e-any-key`)).text();
  check('share page serves the join document', shell.includes('/immich-shared-albums/assets/share.js'),
        shell.slice(0, 120));
  check('settings are not readable without a session',
        (await fetch(`${BS}/immich-shared-albums/settings`)).status === 401);
  check('settings are not writable without a session',
        (await fetch(`${BS}/immich-shared-albums/settings`, { method: 'POST', body: '{}' })).status === 401);
  check('the user panel page needs a session (401 unauth)',
        (await fetch(`${BS}/immich-shared-albums/me`, { redirect: 'manual' })).status === 401);
  check('user-panel album data needs a session (401 unauth)',
        (await fetch(`${BS}/immich-shared-albums/me/albums`)).status === 401);
  check('the join app probes the typed server via the prefixed health route',
        (await (await fetch(`${BS}/immich-shared-albums/assets/share.js`)).text()).includes('/immich-shared-albums/health'));
  const native = await (await fetch(`${BS}/share/e2e-any-key?native=1`)).text();
  check('?native=1 passes the share page through untouched', !native.includes('/immich-shared-albums/assets/share.js'),
        native.slice(0, 120));
}

stage('websocket upgrades pass through the sidecar');
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

stage('security (unauthenticated surface)');
{
  const status = async (url, init) => (await fetch(url, init).catch(() => ({ status: 0 }))).status;

  check('panel refuses an unauthenticated caller',
        [401, 403].includes(await status(`${BS}/immich-shared-albums/`)), `got ${await status(`${BS}/immich-shared-albums/`)}`);
  check('join refuses an unauthenticated caller',
        await status(`${BS}/immich-shared-albums/join`, j({ url: `${ORIGIN_SIDECAR}/share/${shareKey}` })) === 401);
  check('leave refuses an unauthenticated caller',
        await status(`${BS}/immich-shared-albums/leave`, j({ mappingId: 'whatever' })) === 401);

  // A PROXIED REJECTION MUST REACH THE CALLER. Immich's auth guard answers 401 BEFORE reading the
  // request body, and the proxy handed `fetch` a STREAM: undici rejected with "fetch failed", the
  // rejection escaped the handler, and no response was ever written — so every unauthenticated POST
  // through the sidecar hung until the caller gave up, which is what an expired session looks like in
  // a browser. A 400 and a 404 came back in milliseconds, because those routes read the body first,
  // and that is exactly why nothing caught it: the failing case was the one nobody probed.
  const proxiedAt = Date.now();
  const proxied = await fetch(`${BS}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"probe":1}',
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  check('a proxied 401 reaches the caller instead of hanging',
        proxied?.status === 401,
        `status=${proxied?.status ?? 'no response'} after ${Date.now() - proxiedAt}ms`);

  const health = await (await fetch(`${BS}/immich-shared-albums/health`)).json();
  check('health exposes liveness only (no household name, no peer count)',
        health.ok === true && !('household' in health) && !('peers' in health), JSON.stringify(health));

  // The sidecar's own key must be the SCOPED one, and the scope must have teeth: it can list
  // users (required) but cannot delete an asset or mint another key (excluded on purpose).
  const SIDECAR_KEY = process.env.B_SIDECAR_API_KEY;
  if (SIDECAR_KEY) {
    check('sidecar key can do its job (adminUser.read)',
          (await fetch(`${B}/api/admin/users`, { headers: { 'x-api-key': SIDECAR_KEY } })).status === 200);
    check('sidecar key CANNOT delete assets (scope has teeth)',
          (await fetch(`${B}/api/assets`, { method: 'DELETE', headers: { 'x-api-key': SIDECAR_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ['00000000-0000-0000-0000-000000000000'] }) })).status === 403);
    check('sidecar key CANNOT mint itself a broader key (no apiKey.*)',
          (await fetch(`${B}/api/api-keys`, { method: 'POST', headers: { 'x-api-key': SIDECAR_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'escalate', permissions: ['all'] }) })).status === 403);
  } else console.log('  (B_SIDECAR_API_KEY not set — scoped-key checks skipped)');

  check('oversized body is rejected before it is buffered',
        await status(`${BS}/immich-shared-albums/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                             body: 'x'.repeat(2 * 1024 * 1024) }) === 413);

  // Peer operations left HTTP entirely — the router must not even know these paths.
  check('the HTTP surface carries no peer routes any more (redeem)',
        await status(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/invites/redeem`,
                     j({ shareKey, protocol: 2, household: { name: 'imposter' } })) === 404);
  check('the HTTP surface carries no peer routes any more (bytes)',
        await status(`${ORIGIN_DIRECT}/immich-shared-albums/api/v1/assets/x/original`) === 404);
}

stage('security (entitlement — a signed peer is not entitled to everything)');
{
  // Dial as B really is: B's identity (raw ed25519, schema v1) lives in its sidecar volume. Read it with the sqlite3
  // CLI rather than node:sqlite — the runner already depends on the CLI, and node:sqlite
  // needs Node 22+, which would make these checks skip silently on an older host.
  const bKeys = readSidecarKv('b-sidecar', 'identity');
  if (!bKeys) requireState("B's identity from demo/b-sidecar/state.db");

  if (bKeys) {
    const originEp = await endpointOf(ORIGIN_DIRECT);
    // A private album on the origin that was never shared with anyone. Before the fix, any
    // enrolled peer could pull its originals with the admin key just by naming the asset.
    const privAlbum = (await api(A, AKEY, '/albums', j({ albumName: 'not shared with anyone' }))).id;
    const privAsset = await upload(A, AKEY, 'private-e2e.jpg', `pv${Date.now() % 10000}`, '2026-07-01T09:00:00.000Z');
    await ensurePreviews(A, AKEY, [privAsset]);
    await api(A, AKEY, `/albums/${privAlbum}/assets`, { ...j({ ids: [privAsset] }), method: 'PUT' });

    const priv = irohProbe(bKeys, originEp, `/assets/${privAsset}/original`, { wantBytes: true });
    check('a valid peer CANNOT read an asset that was never shared with it (F-05)',
          priv.status === 403, JSON.stringify(priv));

    // Control: the same identity on an asset B genuinely was offered must still work,
    // otherwise the check above would pass simply by breaking all byte reads.
    const ok = irohProbe(bKeys, originEp, `/assets/${aIds[0]}/original`, { wantBytes: true });
    check('the same peer CAN still read an asset it was offered (no over-blocking)',
          ok.status === 200 && ok.bytesLength > 0, JSON.stringify(ok));

    const man = irohProbe(bKeys, originEp, `/albums/${privAlbum}/manifest`);
    check('a valid peer CANNOT read the manifest of an album not mapped to it (F-06)',
          [403, 404].includes(man.status), JSON.stringify(man));

    // The wire contract's evolution surface, asserted over real iroh.
    const hello = irohProbe(bKeys, originEp, '/hello');
    check('/hello names the protocol and a feature list',
          hello.status === 200 && hello.json?.protocol === 2 && Array.isArray(hello.json?.features),
          JSON.stringify(hello.json));
    const fat = irohProbe(bKeys, originEp, '/pair', { bodyPad: 1200 * 1024 });
    check('an over-limit body is ANSWERED with 413, not abandoned mid-stream',
          fat.status === 413 && fat.json?.code === 'body_too_large', JSON.stringify(fat));
    // The fat-frame probe spins up a docker container in the same instant; on Docker Desktop the
    // host->port-proxy connection can hiccup for one request, so retry rather than flake.
    const health = await until(async () => {
      try { return await (await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/health`)).json(); }
      catch { return null; }
    }, 10000, 1000);
    check('the health probe names the protocol, so join cards can diagnose version skew',
          health?.ok === true && health.protocol === 2, JSON.stringify(health));

    await api(A, AKEY, '/assets', { ...j({ ids: [privAsset], force: true }), method: 'DELETE' }).catch(() => {});
    await api(A, AKEY, `/albums/${privAlbum}`, { method: 'DELETE' }).catch(() => {});
  }
}

stage('security (album password gates enrolment)');
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
      jAuth(await inviteFor(ORIGIN_DIRECT, pwKey, { forUserId: meP, password }), BKEY));
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

stage('bot naming uses the project domain');
{
  const bots = (await api(B, BKEY, '/admin/users')).filter(u => isBot(u.email));
  check('bot users exist', bots.length > 0, `${bots.length} found`);
  check('every bot uses the project email domain (.internal, ICANN private-use)',
        bots.every(u => u.email.endsWith('@immich-shared-albums.internal')),
        bots.map(u => u.email.split('@')[1]).filter((v, i, a) => a.indexOf(v) === i).join(', '));
}

stage('security (utility accounts cannot be signed into)');
{
  const utility = (await api(B, BKEY, '/admin/users')).filter(u => isBot(u.email));
  check('utility users exist to own the stubs', utility.length > 0, `${utility.length} found`);
  check('no utility user is an admin', utility.every(u => !u.isAdmin));
  const contributors = readSidecarContributors('b-sidecar');
  if (contributors) {
    const entries = Object.values(contributors);
    const withPassword = entries.filter((c) => c.password).length;
    check('utility accounts were actually provisioned with keys', entries.length > 0 && entries.every((c) => c.apiKey),
          `${entries.length} contributor(s)`);
    check('no utility login password is retained in state.db once provisioned',
          withPassword === 0, `${withPassword} of ${entries.length} still stored`);
  } else console.log('  (skipped password-retention check: cannot read demo/b-sidecar/state.db)');
}

// Server pairing: linking two servers as its own act, with no album involved. This replaces
// bearer-based enrolment, where anyone holding an album share link could attach their server.
// Runs LAST, alongside unlink, because it mutates the peer list.
stage('pairing links two servers on its own (no album)');
{
  const anonMint = await fetch(`${BS}/immich-shared-albums/pairings`, { method: 'POST' });
  check('minting a pairing link needs a session', anonMint.status === 401, `status ${anonMint.status}`);
  const anonPeer = await fetch(`${BS}/immich-shared-albums/pairings`);
  check('listing pairing links needs a session', anonPeer.status === 401, `status ${anonPeer.status}`);

  const res = await fetch(`${BS}/immich-shared-albums/pairings`,
    { method: 'POST', headers: { 'x-api-key': BKEY } });
  const minted = await res.json().catch(() => ({}));
  check('an admin can mint a pairing link', res.ok && !!minted.link, JSON.stringify(minted).slice(0, 120));

  if (minted.link) {
    // The ticket never touches an HTTP server, so the secret cannot reach any log at all —
    // stronger than the old fragment rule it replaces. Assert its shape instead.
    const ticket = minted.link.match(/^isa2-([A-Za-z0-9_-]+)$/);
    const decoded = ticket ? JSON.parse(Buffer.from(ticket[1], 'base64url').toString()) : null;
    check('the pairing string is a self-contained ticket (endpoint + single-use secret, no URL)',
          !!decoded?.pub && !!decoded?.secret && (decoded?.secret || '').length >= 20,
          minted.link.slice(0, 24) + '…');
    check('the link expires within the hour', minted.expiresAt - Date.now() < 3600000,
          `${Math.round((minted.expiresAt - Date.now()) / 60000)} min`);
    // survives being pasted into a messenger: one line, no spaces
    check('the link is a single line with no whitespace', !/\s/.test(minted.link));

    // D redeems B's link. Neither has ever shared an album with the other.
    const before = (await (await fetch(`${DS}/immich-shared-albums/peers`, { headers: { 'x-api-key': DKEY } })).json()).peers || [];
    const rd = await fetch(`${DS}/immich-shared-albums/pair`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': DKEY },
        body: JSON.stringify({ link: minted.link }) });
    const rdOut = await rd.json().catch(() => ({}));
    check('another server can redeem it and the two are linked', rd.ok && !!rdOut.linked,
          JSON.stringify(rdOut).slice(0, 140));

    const after = (await (await fetch(`${DS}/immich-shared-albums/peers`, { headers: { 'x-api-key': DKEY } })).json()).peers || [];
    check('the redeeming side now lists the other server', after.length > before.length,
          `${before.length} -> ${after.length}`);
    const bPeers = (await (await fetch(`${BS}/immich-shared-albums/peers`, { headers: { 'x-api-key': BKEY } })).json()).peers || [];
    check('the minting side lists it too (one round trip pairs both)',
          bPeers.some(p => (p.name || '').includes('(D)')), bPeers.map(p => p.name).join(', '));

    // SECURITY: single-use. A forwarded copy must be inert.
    const replay = await fetch(`${DS}/immich-shared-albums/pair`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': DKEY },
        body: JSON.stringify({ link: minted.link }) });
    check('a pairing link cannot be redeemed twice', !replay.ok, `status ${replay.status}`);

    // SECURITY: shown once. Only a hash persists, so the pending list can never leak a
    // redeemable ticket — not to an admin, not to anyone reading state.db.
    const pending = await (await fetch(`${BS}/immich-shared-albums/pairings`,
      { headers: { 'x-api-key': BKEY } })).json();
    check('pending pairing codes are metadata only — the ticket is shown exactly once',
          (pending.pairings || []).every(p2 => !p2.link && !p2.code && !JSON.stringify(p2).includes('isa2-')),
          JSON.stringify(pending).slice(0, 120));

    // SECURITY: pairing conveys no access to any photo. The newly linked peer must carry zero
    // albums in either direction — what they may see is decided afterwards, per person.
    const linked = after.find(p => !before.some(b => b.pub === p.pub));
    check('pairing on its own shares no albums in either direction',
          !!linked && linked.sharedToUs === 0 && linked.sharedToThem === 0,
          linked ? `${linked.name}: ${linked.sharedToUs} in, ${linked.sharedToThem} out` : 'new peer not found');

    // SECURITY: a made-up code must be refused.
    const bogus = await fetch(`${DS}/immich-shared-albums/pair`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': DKEY },
        body: JSON.stringify({ link: minted.link.replace(/#.*/, '#' + 'x'.repeat(43)) }) });
    check('an invented pairing code is refused', !bogus.ok, `status ${bogus.status}`);
  }
}

// LAST STAGE, deliberately: unlinking is destructive, so it runs after everything that needs
// the B<->C link. Server links are admin-owned objects managed from the panel — not something
// expressed by removing a bot from an album.
stage('panel manages server links (unlink)');
{
  const peersUrl = `${BS}/immich-shared-albums/peers`;
  const anon = await fetch(peersUrl);
  check('connected-servers list is not readable without a session', anon.status === 401,
        `status ${anon.status}`);
  const unlinkAnon = await fetch(`${BS}/immich-shared-albums/unlink`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"pub":"x"}' });
  check('unlink is not callable without a session', unlinkAnon.status === 401,
        `status ${unlinkAnon.status}`);

  const listed = await (await fetch(peersUrl, { headers: { 'x-api-key': BKEY } })).json();
  const target = (listed.peers || []).find(p => (p.name || '').includes('(C)'));
  check('panel lists the connected server with what the link carries', !!target,
        target ? `${target.name}: ${target.people} people, ${target.sharedToUs} in, ${target.sharedToThem} out` : JSON.stringify(listed));
  check('panel reports the people the link made invitable', !!target && target.people > 0,
        `${target?.people} marker(s)`);

  if (target) {
    const beforeUsers = (await api(B, BKEY, '/admin/users')).filter(u => u.email.startsWith('person-'));
    const before = beforeUsers.length;
    const res = await fetch(`${BS}/immich-shared-albums/unlink`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY },
        body: JSON.stringify({ pub: target.pub }) });
    const out = await res.json().catch(() => ({}));
    check('unlink succeeds from the panel', res.ok && out.household, JSON.stringify(out));
    check('unlink removes the mirrors that server shared with us', (out.mirrorsRemoved || 0) > 0,
          `${out.mirrorsRemoved} removed`);

    const gone = await until(async () => {
      const peers = await (await fetch(peersUrl, { headers: { 'x-api-key': BKEY } })).json();
      return (peers.peers || []).some(p => p.pub === target.pub) ? null : true;
    }, 30000);
    check('the server is gone from the panel after unlinking', !!gone, gone ? '' : 'still listed');

    // Its people must leave Immich's picker — that is the visible half of unlinking.
    const afterUsers = (await api(B, BKEY, '/admin/users')).filter(u => u.email.startsWith('person-'));
    check("unlink removed that server's people", afterUsers.length < before,
          `${before} -> ${afterUsers.length}`);
    // Their photos leave with them. Everything these accounts owned was a proxy whose bytes
    // streamed from the peer, so once the link is gone the assets are unreachable and keeping
    // them would only scatter broken thumbnails through albums here.
    // Scoped to the unlinked server: B may hold other live links (it pairs with D two stages
    // up), and their people are allowed to appear here whenever the directory poll ticks.
    const survivors = afterUsers.filter(u => (u.name || '').includes(`(via ${target.name}`));
    check('no account for that server survives the unlink', survivors.length === 0,
          survivors.map(u => u.name).join(', ') || '(none)');
    // SECURITY: deleting the accounts takes their album memberships with them, and nothing may be
    // left behind for a later re-link to misread as a fresh invitation. The hazard is specific to
    // the accounts this unlink just deleted, so the check is scoped to them — this server holds other
    // links (it pairs with D two stages up), whose people are members here by design. An account that
    // is gone from `/admin/users?withDeleted=true` but still listed on an album is exactly the leak.
    const personIdsBefore = new Set(
      (await api(B, BKEY, '/admin/users?withDeleted=true').catch(() => []))
        .filter(u => (u.email || '').startsWith('person-'))
        .map(u => u.id)
    );
    // WAIT for the memberships to go, do not sample once. Immich removes a deleted user's album
    // memberships in its own background job, while `GET /admin/users` stops listing that user the
    // moment the delete is accepted — so there is a window where the account is already gone from
    // the user list and still named on an album, and a single read inside it fails a passing
    // product. Measured on a Docker Desktop host: the memberships cleared 1.2s after a `200 OK`
    // unlink, which is why this only ever went red off-CI. A wait on the condition is what the
    // suite's own rule 1 asks for, and it still fails — on the timeout — if they never go.
    const stillMembers = async () => {
      const left = [];
      for (const al of await api(B, BKEY, '/albums').catch(() => [])) {
        const d = await api(B, BKEY, `/albums/${al.id}?withoutAssets=true`).catch(() => null);
        for (const au of d?.albumUsers || []) {
          const uid = au.user?.id;
          // Re-read the live users each pass: the set shrinks as Immich works through the job, and
          // a membership only counts as left behind once its account is actually gone.
          if (personIdsBefore.has(uid) && !(await api(B, BKEY, '/admin/users').catch(() => []))
            .some(u => u.id === uid)) {
            left.push(`${al.albumName}: ${au.user.email}`);
          }
        }
      }
      return left;
    };
    const cleared = await until(async () => ((await stillMembers()).length === 0 ? true : null), 60000);
    check('no membership is left behind for a re-link to misread as an invitation',
          !!cleared, cleared ? 'none' : (await stillMembers()).join(', '));
    const dead = await fetch(`${BS}/immich-shared-albums/unlink`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY },
        body: JSON.stringify({ pub: target.pub }) });
    check('unlinking an already-unlinked server fails cleanly', dead.status === 400, `status ${dead.status}`);
  }
}

if (DKEY) {
  stage('a peer that lost its mappings is retired after repeated 404s, not retried forever');
  // A member that unlinks or leaves TELLS the origin (see the "left" notices above). The case this
  // guards is the silent one: a peer that lost its mappings without notice — a state restore, the
  // frozen-WAL bug of 2026-09-18 — and answers every push with 404 ("unknown mapping"). The origin
  // used to retry, and log, that push every cycle forever. A 404 is transient by protocol (the
  // mirror may simply not exist yet), so the bar is many consecutive cycles, not a few.
  // Reproduce it exactly: stop D's sidecar, delete ONLY its mapping rows — identity and peers stay,
  // so D still answers C as the same peer — and start it again.
  const dDir = new URL('../household-d', import.meta.url).pathname;
  const dockerEnv2 = { ...process.env, PATH: process.env.PATH + ':/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/usr/bin' };
  const dPub = readSidecarKv('household-d/d-sidecar', 'identity')?.pub;
  const liveMappingsForD = () => {
    const out = sidecarSql('household-c/c-sidecar',
      `SELECT COUNT(*) AS n FROM mappings WHERE role='owner' AND peer='${dPub}' AND COALESCE(dead, 0) NOT IN (1, 'true')`);
    try { return out ? Number(JSON.parse(out)[0].n) : null; } catch { return null; }
  };
  const liveBefore = liveMappingsForD();
  check('rig: the origin holds live owner mappings for D', (liveBefore ?? 0) > 0, `live: ${liveBefore}`);
  let wiped = false;
  try {
    execFileSync('docker', ['compose', 'stop', 'sidecar-d'], { cwd: dDir, env: dockerEnv2, stdio: 'ignore' });
    // A throwaway sqlite container on the same volume, NOT `--entrypoint node`: the sidecar image
    // is what is under test, and under a Rust sidecar it has no node. The sidecar is STOPPED for
    // this (above), so nothing holds the database and there is no lock to share.
    const dVolume = sidecarDataDir('household-d/d-sidecar');
    if (!dVolume) throw new Error('could not resolve sidecar-d\'s data dir');
    execFileSync('docker', ['run', '--rm', '-v', `${dVolume}:/data`, READER_IMAGE,
                            'sqlite3', '/data/state.db', 'DELETE FROM mappings'],
                 { stdio: ['ignore', 'pipe', 'ignore'], env: dockerEnv2, timeout: 30000 });
    execFileSync('docker', ['compose', 'start', 'sidecar-d'], { cwd: dDir, env: dockerEnv2, stdio: 'ignore' });
    wiped = true;
  } catch (e) { console.log(`  (could not wipe D's mappings: ${String(e.message).split('\n')[0].slice(0, 100)})`); }
  check("rig: D's sidecar restarted with its mappings wiped and its identity intact", wiped);
  if (wiped && (liveBefore ?? 0) > 0) {
    await waitFor(async () => (await fetch(`${DS}/immich-shared-albums/health`).catch(() => ({ ok: false }))).ok, 30000);
    // Something for the origin to push, so the 404s actually happen.
    const nudge = await upload(A, AKEY, 'after-loss.jpg', `al${Date.now() % 10000}`, '2026-08-20T10:00:00.000Z');
    await ensurePreviews(A, AKEY, [nudge]);
    await api(A, AKEY, `/albums/${ALBUM_ID}/assets`, { ...j({ ids: [nudge] }), method: 'PUT' });
    const retired = await until(async () => liveMappingsForD() === 0 ? true : null, 120000);
    check('the origin retires a mapping its peer keeps answering 404 to, instead of retrying forever',
          !!retired, retired ? `${liveBefore} -> 0 live` : `still ${liveMappingsForD()} live after 120s`);
  }
}

// The Rust build only: the removal channel, caption propagation and the origin-side leave
// reclaim are Rust features the TypeScript never had. The runtime probe is the same one the
// state reader uses - a Rust sidecar's image has no node in it.
if (!sidecarHasNode('b-sidecar')) {
  stage('rust: deleted contributions, caption edits and leaves reclaim what they should');
  {
    const t = `rust lifecycle ${Date.now()}`;
    console.log(`  (rust lc env: BKEY=${typeof BKEY}/${(BKEY || '').length} AKEY=${typeof AKEY}/${(AKEY || '').length})`);
    const originAlbum = await api(A, AKEY, '/albums', j({ albumName: t }));
    const originPhoto = await upload(A, AKEY, 'rust-lc.jpg', `rl${Date.now() % 10000}`, '2026-08-15T10:00:00.000Z');
    await ensurePreviews(A, AKEY, [originPhoto]);
    // the caption exists BEFORE the join, so the stub materialises with it (plus the credit line)
    await api(A, AKEY, `/assets/${originPhoto}`, { ...j({ description: 'caption v1' }), method: 'PUT' });
    await api(A, AKEY, `/albums/${originAlbum.id}/assets`, { ...j({ ids: [originPhoto] }), method: 'PUT' });
    // The stage runs at the lane\u2019s tail, where Immich may still be churning the bulk album\u2019s
    // metadata jobs - a whoami that times out reads as needsAuth. Retry: the 401 is transient.
    let joinLc = null;
    for (let attempt = 0; attempt < 4 && !(joinLc && joinLc.album); attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 10000));
      const linkKey = (await api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: originAlbum.id, allowUpload: true }))).key;
      const init = jAuth(await inviteFor(ORIGIN_DIRECT, linkKey), BKEY);
      joinLc = await (await fetch(`${BS}/immich-shared-albums/join`, init)).json();
    }
    check('rust lc: joined', !!joinLc.album, JSON.stringify(joinLc).slice(0, 90));
    const mirrorLc = await until(async () => {
      const found = (await api(B, BKEY, '/albums')).find(a => a.albumName === joinLc.album && a.assetCount > 0);
      return found || null;
    }, 90000);
    check('rust lc: the mirror holds the stub', !!mirrorLc, mirrorLc ? '' : 'timed out');
    const meIdLc = (await api(B, BKEY, '/users/me')).id;
    const stubLc = (await albumAssets(B, BKEY, mirrorLc.id)).find(a => a.ownerId !== meIdLc);
    const stubDesc = (await api(B, BKEY, `/assets/${stubLc.id}`)).exifInfo?.description || '';
    check('rust lc: the stub materialised with the origin caption plus the credit line',
          stubDesc.includes('caption v1') && stubDesc.includes('Shared by'), stubDesc.slice(0, 70));

    // 1. the joiner CONTRIBUTES: their own photo, added to the mirror (the picker\u2019s gesture)
    const contribution = await upload(B, BKEY, 'rust-contrib.jpg', `rc${Date.now() % 10000}`, '2026-08-16T10:00:00.000Z');
    await api(B, BKEY, `/albums/${mirrorLc.id}/assets`, { ...j({ ids: [contribution] }), method: 'PUT' });
    const originGrew = await until(async () =>
      (await albumAssets(A, AKEY, originAlbum.id)).length >= 2 ? true : null, 120000);
    check('rust lc: the contribution reached the ORIGIN (as a stub of the joiner\u2019s asset)', !!originGrew,
          originGrew ? '' : `origin still ${(await albumAssets(A, AKEY, originAlbum.id)).length}`);
    const meIdA = (await api(A, AKEY, '/users/me')).id;
    const originAll = await albumAssets(A, AKEY, originAlbum.id);
    const originStub = originAll.find(a => a.ownerId !== meIdA);
    check('rust lc: the origin holds the contribution as a stub', !!originStub, originStub ? '' : 'not found');

    // 2. the joiner DELETES their contribution - the removal channel reclaims the origin\u2019s stub
    await api(B, BKEY, '/assets', { ...j({ ids: [contribution], force: true }), method: 'DELETE' });
    const originShrunk = await until(async () =>
      (await albumAssets(A, AKEY, originAlbum.id)).length === 1 ? true : null, 120000);
    check('rust lc: deleting the contribution reclaims the ORIGIN\u2019s stub (remove channel)', !!originShrunk,
          originShrunk ? '' : `origin still ${(await albumAssets(A, AKEY, originAlbum.id)).length}`);

    // 3. the origin EDITS THE CAPTION through its own sidecar (the proxy path the trigger fires on)
    await api(A, AKEY, `/assets/${originPhoto}`, { ...j({ description: 'caption v2' }), method: 'PUT' });
    const csPing = await fetch(`${ORIGIN_DIRECT}/immich-shared-albums/health`).then(r => r.ok).catch(() => false);
    check('rust lc: the origin sidecar fronts Immich (the trigger needs the write to pass through it)', csPing, '');
    if (csPing) {
      await fetch(`${ORIGIN_DIRECT}/api/assets/${originPhoto}`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AKEY }, body: JSON.stringify({ description: 'caption v2' }) });
      const stubFollowed = await until(async () => {
        const desc = (await api(B, BKEY, `/assets/${stubLc.id}`)).exifInfo?.description || '';
        return desc.includes('caption v2') ? true : null;
      }, 120000);
      const descNow = (await api(B, BKEY, `/assets/${stubLc.id}`)).exifInfo?.description || '';
      check('rust lc: the caption EDIT reaches the stub through trigger + nudge + forced reconcile',
            !!stubFollowed, descNow.slice(0, 70));
    }

    // 4. the joiner LEAVES: the origin reclaims the departed contributor\u2019s remaining stubs
    await api(B, BKEY, `/albums/${mirrorLc.id}/user/me`, { method: 'DELETE' });
    const originReclaimed = await until(async () => {
      const items = await albumAssets(A, AKEY, originAlbum.id);
      return items.length === 1 && items[0].ownerId === meIdA ? true : null;
    }, 120000);
    check('rust lc: the leave reclaims the departed contributor\u2019s stub on the ORIGIN (google-photos semantics)',
          !!originReclaimed, originReclaimed ? '' : `origin still ${(await albumAssets(A, AKEY, originAlbum.id)).length}`);
    // The row that MAY remain is one that names no proxy (an empty originAsset — bookkeeping for
    // the owner\u2019s own photo); what must be gone is any PROXY of the departed member\u2019s content.
    const lcLedger = sidecarSql('c-sidecar',
      `SELECT COUNT(*) AS n FROM seen WHERE mapping IN (SELECT id FROM mappings WHERE albumName=${JSON.stringify(t)}) AND originAsset != ''`);
    const lcRows = lcLedger ? JSON.parse(lcLedger)[0].n : -1;
    check('rust lc: no proxy of the departed member\u2019s content survives on the origin', lcRows === 0, `proxy rows=${lcRows}`);
    await api(B, BKEY, `/albums/${mirrorLc.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

// Store-shared-locally: the backfill turns stubs into real local copies, and a LEAVE must
// withdraw the share WITHOUT deleting those copies - the household paid real disk for them.
if (!sidecarHasNode('b-sidecar')) {
  stage('rust: store-shared-locally survives a leave');
  {
    const t = `rust stored ${Date.now()}`;
    const originAlbum = await api(A, AKEY, '/albums', j({ albumName: t }));
    const originPhoto = await upload(A, AKEY, 'rust-stored.jpg', `rs${Date.now() % 10000}`, '2026-08-15T10:00:00.000Z');
    await ensurePreviews(A, AKEY, [originPhoto]);
    await api(A, AKEY, `/albums/${originAlbum.id}/assets`, { ...j({ ids: [originPhoto] }), method: 'PUT' });
    const joinSt = await joinWithRetry(() => api(A, AKEY, '/shared-links', j({ type: 'ALBUM', albumId: originAlbum.id, allowUpload: true })));
    check('stored: joined', !!joinSt.album, JSON.stringify(joinSt).slice(0, 80));
    const mirrorSt = await until(async () => {
      const found = (await api(B, BKEY, '/albums')).find(a => a.albumName === joinSt.album && a.assetCount > 0);
      return found || null;
    }, 90000);
    const stubSt = (await albumAssets(B, BKEY, mirrorSt.id)).find(a => true);
    check('stored: the stub exists', !!stubSt, stubSt ? '' : 'timed out');

    // flip the toggle ON, then wait for the backfill (the reconcile drains it when the setting is on)
    await fetch(`${BS}/immich-shared-albums/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY }, body: JSON.stringify({ storeSharedAssetsLocally: true }) });
    const backfilled = await until(async () => {
      const rows = sidecarSql('b-sidecar',
        `SELECT storedFull FROM seen WHERE mapping IN (SELECT id FROM mappings WHERE albumId='${mirrorSt.id}')`);
      const parsed = rows ? JSON.parse(rows) : [];
      return parsed.length > 0 && parsed.every(r => r.storedFull === 1) ? parsed : null;
    }, 240000);
    check('stored: the backfill upgraded the stub to a full local copy', !!backfilled,
          backfilled ? 'storedFull=1' : 'still a stub');
    const copyBytes = await (await fetch(`${B}/api/assets/${stubSt.id}/original`, { headers: { 'x-api-key': BKEY } })).arrayBuffer();
    check('stored: the local copy holds the OWNER\u2019s real bytes', copyBytes.byteLength > 500, `${copyBytes.byteLength}B`);

    // the joiner LEAVES natively - the share is withdrawn, the STORED COPY stays
    await api(B, BKEY, `/albums/${mirrorSt.id}/user/me`, { method: 'DELETE' });
    const mappingGone = await until(async () => {
      const rows = sidecarSql('b-sidecar',
        `SELECT (SELECT COUNT(*) FROM mappings WHERE albumId='${mirrorSt.id}') AS m,
                (SELECT COUNT(*) FROM seen WHERE mapping IN (SELECT id FROM mappings WHERE albumId='${mirrorSt.id}') AND storedFull=1) AS kept,
                (SELECT COUNT(*) FROM seen WHERE mapping IN (SELECT id FROM mappings WHERE albumId='${mirrorSt.id}') AND storedFull=0) AS purged`);
      const parsed = rows ? JSON.parse(rows)[0] : { m: -1, kept: -1, purged: -1 };
      return parsed.m === 0 && parsed.kept >= 1 ? parsed : null;
    }, 480000);
    check('stored: the leave removes the mapping and its proxy rows but KEEPS the stored copy\u2019s ledger row',
          !!mappingGone, mappingGone ? `kept=${mappingGone.kept}` : 'timed out');
    const copySurvives = await fetch(`${B}/api/assets/${stubSt.id}/original`, { headers: { 'x-api-key': BKEY } });
    const survivedBytes = await copySurvives.arrayBuffer();
    check('stored: THE STORED COPY SURVIVES THE LEAVE (the user\u2019s actual requirement)',
          copySurvives.ok && survivedBytes.byteLength === copyBytes.byteLength,
          `${survivedBytes.byteLength}B status=${copySurvives.status}`);
    // tidy: the toggle back off, the stored copy\u2019s asset deleted (it is a utility-owned test asset)
    await fetch(`${BS}/immich-shared-albums/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-api-key': BKEY }, body: JSON.stringify({ storeSharedAssetsLocally: false }) });
    await api(B, BKEY, '/assets', { ...j({ ids: [stubSt.id], force: true }), method: 'DELETE' });
  }
}

if (process.env.E2E_PROFILE) {
  const total = WAITS.reduce((s, w) => s + w.ms, 0);
  const polls = WAITS.reduce((s, w) => s + w.polls, 0);
  console.log(`\n— wait profile: ${WAITS.length} until() calls, ${(total / 1000).toFixed(1)}s waiting, ${polls} polls`);
  for (const w of [...WAITS].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
    console.log(`   ${(w.ms / 1000).toFixed(1).padStart(6)}s  ${String(w.polls).padStart(3)} polls  ${w.ok ? 'ok' : 'TIMEOUT'}`);
  }
}

process.exit(summary() ? 1 : 0);
