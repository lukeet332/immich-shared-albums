#!/usr/bin/env node
// verify/verify-nudges-browser.mjs — the hand-driven, real-browser proof for issue #116's
// acceptance: an album made in the app — through the sidecar's own proxy, with the signed-in
// person's session — reaches the OTHER household's panel in seconds while both backstops are
// 300s out, so only the channel nudges can have carried it. Driven in a real Chromium: the
// write is a same-origin fetch from the person's own panel page, carrying their session.
//
// Run through verify/verify-nudges-browser.sh (it recreates the rig's sidecars at long
// backstops first and restores them after). Preconditions: the API lane has run (the admin
// accounts exist) and the rig is up.
import { chromium } from 'playwright';

const PORT = (name, dflt) => process.env[name] || dflt;
const B_WEB = process.env.B_PANEL_WEB || `http://localhost:${PORT('PORT_SIDECAR_B', 8301)}`;
const C_WEB = process.env.C_PANEL_WEB || `http://localhost:${PORT('PORT_SIDECAR_C', 8302)}`;
const C_IMMICH = `http://localhost:${PORT('PORT_IMMICH_C', 2285)}`;
const B_EMAIL = process.env.B_EMAIL || 'admin@e2e.local';
const B_PASS = process.env.B_PASS || 'e2e-admin-pass-1';
const CKEY = process.env.CKEY;
if (!CKEY) { console.error('❌ CKEY is required (household-c/.env)'); process.exit(1); }

let passed = 0; let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const cConfig = await (await fetch(`${C_IMMICH}/api/system-config`, { headers: { 'x-api-key': CKEY } })).json();
const systemConfig = async () => (await fetch(`${C_IMMICH}/api/system-config`, { headers: { 'x-api-key': CKEY } })).json();
const setPasswordLogin = async (enabled) => {
  const put = await fetch(`${C_IMMICH}/api/system-config`, { method: 'PUT',
    headers: { 'x-api-key': CKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...cConfig, passwordLogin: { ...cConfig.passwordLogin, enabled } }) });
  for (let attempt = 0; attempt < 30 && put.ok; attempt++) {
    if ((await systemConfig())?.passwordLogin?.enabled === enabled) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

const signIn = async (base) => {
  let reEnabled = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const answer = await fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: B_EMAIL, password: B_PASS }) });
    const body = await answer.json().catch(() => ({}));
    if (body?.accessToken) return body;
    if (reEnabled < 3 && /password login has been disabled/i.test(`${answer.status} ${JSON.stringify(body)}`)) {
      reEnabled += 1; await setPasswordLogin(true);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { failed: true };
};

const panelOf = async (browser, base, token) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.addCookies(['immich_access_token', 'immich_auth_type', 'immich_is_authenticated'].map((name) => ({
    name, url: base,
    value: name === 'immich_access_token' ? token : (name === 'immich_auth_type' ? 'password' : 'true'),
  })));
  await page.goto(`${base}/immich-shared-albums/me`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !/Loading/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  return { context, page };
};

const panelText = async (page) => (await page.locator('body').innerText().catch(() => '')) || '';
const candidates = (text) => (text.split('Possible album reunions')[1] || '').split('Your shared albums')[0];
const seesAlbum = (text, name) => new RegExp(name).test(candidates(text));

const cStatus = async (token) => {
  const body = await (await fetch(`${C_WEB}/immich-shared-albums/sync/status`, {
    headers: { Authorization: `Bearer ${token}` } })).json().catch(() => ({}));
  return { ticks: body?.ticks || {}, nudges: body?.nudges || {} };
};

const launchArgs = ['--disable-features=HttpsUpgrades,LocalNetworkAccessChecks,PrivateNetworkAccessNavigations,PrivateNetworkAccessChecks'];
if (process.env.HOST_RESOLVER_RULES) launchArgs.push(`--host-resolver-rules=${process.env.HOST_RESOLVER_RULES}`);
const browser = await chromium.launch({ args: launchArgs });

console.log('== verify-nudges-browser: an album made in the app reaches the peer\'s panel before any backstop could ==');

const albumName = `hand nudge ${Date.now()}`;
// C's half of the pair exists BEFORE either panel opens, so the only thing that can move is B's.
const cHalf = await (await fetch(`${C_IMMICH}/api/albums`, { method: 'POST',
  headers: { 'x-api-key': CKEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ albumName }) })).json();
check('the peer\'s half of the pair exists', !!cHalf?.id, JSON.stringify(cHalf).slice(0, 80));

const bLogin = await signIn(B_WEB);
const cLogin = await signIn(C_WEB);
check('both households are signed in through their own sidecars', !!bLogin.accessToken && !!cLogin.accessToken);

const bPanel = await panelOf(browser, B_WEB, bLogin.accessToken);
const cPanel = await panelOf(browser, C_WEB, cLogin.accessToken);
await bPanel.page.waitForTimeout(3000);
await cPanel.page.waitForTimeout(3000);

// STILLNESS first: with both backstops 300s out and the setup's publishes settled, no lane may
// tick — so whatever ticks after the write below can only be the nudge, not a timer.
const stillBefore = await cStatus(cLogin.accessToken);
await cPanel.page.waitForTimeout(15000);
const stillAfter = await cStatus(cLogin.accessToken);
check('no lane ticked on the peer in 15s — the 300s backstops are quiet',
  stillAfter.ticks.invites === stillBefore.ticks.invites && stillAfter.ticks.watcher === stillBefore.ticks.watcher,
  `${JSON.stringify(stillBefore)} -> ${JSON.stringify(stillAfter)}`);

// THE WRITE, as the person makes it: a same-origin fetch from their own panel page, carrying
// their session — through the sidecar's proxy, the one path a real app write ever takes.
const createdAt = Date.now();
const writeStatus = await bPanel.page.evaluate(async (name) => {
  const response = await fetch('/api/albums', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ albumName: name }) });
  return response.status;
}, albumName);
check('the album was made in the app, through the sidecar\'s proxy', String(writeStatus).startsWith('2'), `POST answered ${writeStatus}`);

let wokeAt = null;
let statusNow = stillAfter;
for (const deadline = Date.now() + 25000; Date.now() < deadline; ) {
  await cPanel.page.waitForTimeout(1000);
  statusNow = await cStatus(cLogin.accessToken);
  if (statusNow.ticks.invites > stillAfter.ticks.invites
      || statusNow.ticks.watcher > stillAfter.ticks.watcher) { wokeAt = Date.now(); break; }
}
// The failure detail names the two halves separately — a counted nudge without a tick is a lane
// that did not wake; no counted nudge at all is a tell that never arrived.
check('the write woke the peer\'s lanes in seconds, not at its backstop', !!wokeAt,
  wokeAt ? `${(wokeAt - createdAt) / 1000}s`
    : `no tick in 25s — nudges ${JSON.stringify(stillAfter.nudges)} -> ${JSON.stringify(statusNow.nudges)}`);

let sawPair = false;
for (const deadline = Date.now() + 20000; Date.now() < deadline && !sawPair; ) {
  await cPanel.page.reload({ waitUntil: 'domcontentloaded' });
  await cPanel.page.waitForTimeout(2000);
  sawPair = seesAlbum(await panelText(cPanel.page), albumName);
}
check('and the peer\'s OWN panel offers the reunion — the pair, seconds after the write', sawPair,
  (await panelText(cPanel.page)).split('\n').filter((l) => /Possible album reunions|hand nudge/.test(l)).slice(0, 3).join(' | ') || '(no section)');

await bPanel.page.reload({ waitUntil: 'domcontentloaded' });
await bPanel.page.waitForTimeout(3000);
check('the writer\'s own panel offers the same reunion',
  seesAlbum(await panelText(bPanel.page), albumName));

await browser.close();
console.log();
if (failed === 0) { console.log(`✅ ALL PASS (${passed})`); process.exit(0); }
console.log(`💥 ${failed} FAILURES (${passed} passed)`); process.exit(failed);
