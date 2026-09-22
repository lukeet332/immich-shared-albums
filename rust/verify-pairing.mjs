// rust/verify-pairing.mjs — two RUST sidecars pairing with each other, over the real wire.
import { createRequire } from 'node:module';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(REPO + '/package.json');

const A = 'http://localhost:9410';
const B = 'http://localhost:9420';
// The rig's host port map, the same one demo/e2e uses: 2384 here is THIS host's shift, and a
// default checkout (or CI) runs the mocks on 2284-2286.
const PORT = (name, dflt) => process.env[name] || dflt;
const IMMICH = `http://localhost:${PORT('PORT_IMMICH_B', 2284)}`;
const EMAIL = 'admin@e2e.local';
const PASSWORD = 'e2e-admin-pass-1';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const login = await fetch(`${IMMICH}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const session = (login.headers.getSetCookie?.() ?? [])
  .map(c => c.split(';')[0])
  .find(c => c.includes('access_token'));

const call = async (base, path, { method = 'GET', body } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { cookie: session, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text };
};

// ---- the panel gate: pairing is admin-only on both sides ----
const anon = await fetch(`${A}/immich-shared-albums/pairings`);
check('minting needs a session', anon.status === 401, `status=${anon.status}`);

const before = await call(A, '/immich-shared-albums/peers');
check('A starts with no linked servers', before.json?.peers?.length === 0, `peers=${before.json?.peers?.length}`);

// ---- mint on A: the ticket is shown exactly once ----
const minted = await call(A, '/immich-shared-albums/pairings', { method: 'POST' });
check('A mints a pairing link', minted.status === 200 && !!minted.json?.link, `status=${minted.status}`);
const link = minted.json?.link || '';
check('the link is an isa2- ticket on one line', link.startsWith('isa2-') && !/\s/.test(link), `${link.slice(0, 14)}…`);
const ttlMinutes = Math.round((minted.json.expiresAt - Date.now()) / 60000);
check('it expires within the configured window', ttlMinutes >= 5 && ttlMinutes <= 1440, `${ttlMinutes} minutes`);

// Only the HASH persists — the panel must never be able to re-show the ticket.
const list = await call(A, '/immich-shared-albums/pairings');
const listed = JSON.stringify(list.json);
check('the pending list shows metadata only, never the ticket', !listed.includes(link), listed.slice(0, 90));
check('and shows one pending code', list.json?.pairings?.length === 1, `pairings=${list.json?.pairings?.length}`);

// ---- redeem on B: one round trip pairs both ends ----
const redeemed = await call(B, '/immich-shared-albums/pair', { method: 'POST', body: { link } });
check('B redeems the link', redeemed.status === 200, `${redeemed.status} ${JSON.stringify(redeemed.json).slice(0, 80)}`);
check('and learns who it paired with', redeemed.json?.linked === 'Household Alpha', String(redeemed.json?.linked));

// ---- both sides now know each other ----
const aPeers = await call(A, '/immich-shared-albums/peers');
const bPeers = await call(B, '/immich-shared-albums/peers');
check(
  'the MINTING side now lists the redeemer',
  aPeers.json?.peers?.some(p => p.name === 'Household Beta'),
  JSON.stringify(aPeers.json?.peers?.map(p => p.name))
);
check(
  'the REDEEMING side lists the minter',
  bPeers.json?.peers?.some(p => p.name === 'Household Alpha'),
  JSON.stringify(bPeers.json?.peers?.map(p => p.name))
);
check(
  'and B recorded the wire protocol it learned',
  bPeers.json?.peers?.every(p => p.version === '1.1.1'),
  JSON.stringify(bPeers.json?.peers?.map(p => `${p.name} v${p.version}`))
);
check('pairing on its own shares no albums', (aPeers.json?.albums?.length || 0) === 0 && (bPeers.json?.albums?.length || 0) === 0);

// ---- SINGLE USE: the same ticket again must fail ----
const replay = await call(B, '/immich-shared-albums/pair', { method: 'POST', body: { link } });
check('a replayed link is refused (single use)', replay.status === 400, `${replay.status} ${replay.json?.error || ''}`);
const replay2 = await call(A, '/immich-shared-albums/pair', { method: 'POST', body: { link } });
check('and refused from the other side too', replay2.status === 400, `${replay2.status}`);

// ---- an invented ticket is refused, and one for THIS server ----
const invented = await call(B, '/immich-shared-albums/pair', { method: 'POST', body: { link: 'isa2-bm90LWEtdGlja2V0' } });
check('an invented ticket is refused', invented.status === 400, `${invented.status}`);
const selfLink = await call(A, '/immich-shared-albums/pair', { method: 'POST', body: { link } });
check('a stale link is refused cleanly rather than hanging', selfLink.status === 400, `${selfLink.status}`);

console.log(`\n${results.every(r => r.ok) ? '✅ ALL PASS' : '❌ FAILURES'} (${results.filter(r => r.ok).length}/${results.length})`);
process.exit(results.every(r => r.ok) ? 0 : 1);
