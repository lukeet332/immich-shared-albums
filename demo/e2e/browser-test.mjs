// Browser-level assertions for the banner + accept flows — the surfaces the API suite
// structurally cannot see. Runs headless against the mocks after the main suite.
// Env: CKEY (origin admin key). Exits non-zero on any failure.
import { chromium } from 'playwright';

// Addresses follow the same PORT_* map as run-mock-e2e.sh and the composes (loopback-bound).
const PORT = (name, dflt) => process.env[name] || dflt;
const C = `http://localhost:${PORT('PORT_IMMICH_C', 2285)}`;
// The share page is browsed on host.docker.internal so one hostname works for the runner's
// browser (CI maps it to 127.0.0.1 in /etc/hosts; a dev machine uses HOST_RESOLVER_RULES below).
// The join itself carries the origin's iroh endpoint token from the page, so B's sidecar never
// has to reach this host address — only the browser does.
const SHARE_HOST = process.env.SHARE_HOST || `http://host.docker.internal:${PORT('PORT_SIDECAR_C', 8302)}`;
const B_ADDR = process.env.B_ADDR || `host.docker.internal:${PORT('PORT_SIDECAR_B', 8301)}`;   // typed into the banner
const B_PANEL_WEB = process.env.B_PANEL_WEB || `http://localhost:${PORT('PORT_SIDECAR_B', 8301)}`;
const B_EMAIL = process.env.B_EMAIL || 'demo@household-b.local';
const B_PASS = process.env.B_PASS || 'demo-household-b-1';
const CKEY = process.env.CKEY;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`); };

// seed: an album + share link on the origin
const api = async (path, body) => (await fetch(`${C}/api${path}`, { method: 'POST',
  headers: { 'x-api-key': CKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const album = await api('/albums', { albumName: `browser test ${Date.now()}` });
const share = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: true });
const SHARE_PATH = `/share/${share.key}`;

// CI puts `host.docker.internal` in /etc/hosts; a dev machine has no reason to. Setting
// HOST_RESOLVER_RULES lets this lane run locally without touching the host's DNS, which matters
// because it is the ONLY coverage of the banner and accept flows — the API suite cannot see them.
//   HOST_RESOLVER_RULES="MAP host.docker.internal 127.0.0.1" node browser-test.mjs
const launchArgs = [
  '--disable-features=HttpsUpgrades,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,PrivateNetworkAccessChecks',
];
if (process.env.HOST_RESOLVER_RULES) {
  launchArgs.push(`--host-resolver-rules=${process.env.HOST_RESOLVER_RULES}`);
}
const browser = await chromium.launch({ args: launchArgs });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Collect the framed document's own status. Visibility is not enough: an iframe renders happily
// while its document 404s, which is exactly what happened when our `?native=1` marker reached
// Immich — the album still booted client-side, so a screenshot looked right, but the
// SERVER-rendered share metadata was gone (a copied link previewed as nothing) and the status was
// 404. The lane asserted `isVisible()` and saw none of it.
const frameStatuses = [];
page.on('response', (r) => {
  if (r.url().includes('?native=1')) frameStatuses.push(r.status());
});

// 1. our share document: the join card floats over the framed native album
await page.goto(`${SHARE_HOST}${SHARE_PATH}`, { waitUntil: 'networkidle' });
const banner = page.locator('#immich-shared-albums-banner .card');
check('join card renders on the share page', await banner.isVisible().catch(() => false));
check('the native album is framed behind it',
  await page.locator('iframe.native-album').isVisible().catch(() => false));

// ...and the frame contains the ALBUM, not just our own error page rendered inside it.
const framed = await page
  .frameLocator('iframe.native-album')
  .locator('body')
  .innerText()
  .catch(() => '');
check('the framed album is really the album: 200, and it names itself',
  frameStatuses.includes(200) && framed.includes(album.albumName),
  `status=${JSON.stringify(frameStatuses)} frame names the album=${framed.includes(album.albumName)}`);

// 1b. dismiss -> clean handoff to the untouched native page
await page.locator('#immich-shared-albums-banner .dismiss').click();
const wentNative = await page.waitForURL('**native=1**', { timeout: 10000 }).then(() => true).catch(() => false);
check('dismiss hands over to the native share page', wentNative, page.url());
check('nothing of ours is on the native page',
  !(await page.locator('#immich-shared-albums-banner').count()));
await page.goto(`${SHARE_HOST}${SHARE_PATH}`, { waitUntil: 'networkidle' });

// 2. bad address -> inline error, no navigation
const input = page.locator('#immich-shared-albums-banner input');
await input.fill('no-addon.example.invalid');
await page.locator('#immich-shared-albums-banner button.join').click();
await page.waitForTimeout(7000);
const err = page.locator('#immich-shared-albums-banner .err');
check('unknown server shows inline error (no 404 stranding)',
  await err.isVisible().catch(() => false) && page.url().includes('/share/'));

// 3. auto-capitalised scheme + scheme discovery still reach the accept page
await input.fill('Http://' + B_ADDR);
await page.locator('#immich-shared-albums-banner button.join').click();
const reached = await page.waitForURL('**/immich-shared-albums/accept*', { timeout: 20000 }).then(() => true).catch(() => false);
check('"Http://"-cased address still reaches the accept page', reached);

// 4. signed-out accept page: sign-in prompt, Accept disabled
if (reached) {
  await page.waitForTimeout(2500);
  const who = await page.locator('#who').textContent().catch(() => '');
  const disabled = await page.locator('#go').isDisabled().catch(() => false);
  check('signed-out accept page prompts sign-in and disables Accept',
    /sign in/i.test(who || '') && disabled, (who || '').slice(0, 60));
}

// 5. signed-in accept -> join -> progress button appears and eventually enables
const login = await (await fetch(`${B_PANEL_WEB}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: B_EMAIL, password: B_PASS }) })).json();
if (!login.accessToken) { console.log(`  ❌ login failed for ${B_EMAIL} — cannot run signed-in checks`); process.exit(1); }
// cookies are domain-scoped: they must be set for the ACCEPT PAGE's origin (the
// address typed into the banner), not the localhost alias used for the login API
await ctx.addCookies(['immich_access_token', 'immich_auth_type', 'immich_is_authenticated'].map((name) => ({
  name, url: `http://${B_ADDR}`,
  value: name === 'immich_access_token' ? login.accessToken : (name === 'immich_auth_type' ? 'password' : 'true'),
})));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('who')?.textContent?.includes('Joining as'), null, { timeout: 15000 }).catch(() => {});
const whoIn = await page.locator('#who').textContent().catch(() => '');
check('signed-in accept page recognises the user', /Joining as/.test(whoIn || ''), (whoIn || '').slice(0, 50));

// 5b. A LATE REUNIFIER — someone who already owns an album of the link's name. This is the case the
// page exists to ask about, and without seeding it the branch that CHOOSES between joining and
// reuniting is the one part of the page no test ever renders. Created through the API on the
// session, then reloaded so the offer is computed fresh.
const ownAlbum = await (await fetch(`${B_PANEL_WEB}/api/albums`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify({ albumName: album.albumName }),
})).json();
check('the lane can give the joiner an album of the link\'s own name', !!ownAlbum?.id,
  ownAlbum?.id ? ownAlbum.id.slice(0, 8) : JSON.stringify(ownAlbum).slice(0, 60));
await page.reload({ waitUntil: 'networkidle' });
const offered = await page.locator('#reunion').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
check('accept page offers the reunion rather than a second album of the same name', offered,
  (await page.locator('#reunion').textContent().catch(() => '')).slice(0, 70));
check('and keeps the separate join visible as the other choice',
  await page.locator('#joinseparate').isVisible().catch(() => false));

// The primary button is now the REUNION, so this lane drives the reunite path; plain joins are
// covered by the API suite, which does them throughout.
await page.locator('#go').click();
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('Joined'), null, { timeout: 60000 }).catch(() => {});
check('join completes fast (async join)', (await page.locator('#out').textContent().catch(() => '')).includes('Joined'));
const btnReady = await page.waitForFunction(() => {
  const b = document.getElementById('openapp');
  return b && b.textContent.includes('Open in Immich app');
}, null, { timeout: 90000 }).then(() => true).catch(() => false);
check('app button enables once the album is filled (gated deeplink)', btnReady);

// 6. the root chooser, in a real browser — because the branch that matters is client-side. The
// API suite can only read the shell: whether a non-admin is actually redirected to their own panel
// is decided by the chooser's useEffect, which needs a browser to run. This lane has B's admin
// credentials, so it can mint a genuine non-admin session rather than assume one exists.
const sidecarRoot = `${B_PANEL_WEB}/immich-shared-albums/`;
// Cookies are ORIGIN-scoped: the session set above belongs to `host.docker.internal` (the address
// typed into the banner), and this navigates to `localhost`. Without its own cookie the sidecar
// sees no session, the chooser's fetch 401s, and the admin gets the error card instead.
await ctx.addCookies(['immich_access_token', 'immich_auth_type', 'immich_is_authenticated'].map((name) => ({
  name, url: B_PANEL_WEB,
  value: name === 'immich_access_token' ? login.accessToken : (name === 'immich_auth_type' ? 'password' : 'true'),
})));
await page.goto(sidecarRoot, { waitUntil: 'networkidle' });
const chooserShown = await page.locator('text=Server settings and pairings').count();
check('an admin at the root is offered both panels', chooserShown > 0, `grep=${chooserShown}`);
check('the admin stays at the root rather than being sent to a panel',
  page.url().replace(/\/+$/, '') === sidecarRoot.replace(/\/+$/, ''), page.url());

const adminToken = (await (await fetch(`${B_PANEL_WEB}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: B_EMAIL, password: B_PASS }) })).json()).accessToken;
const nonAdminEmail = `browser-nonadmin@e2e.local`;
const nonAdminPass = 'browser-nonadmin-pass-1';
await fetch(`${B_PANEL_WEB}/api/admin/users`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
  body: JSON.stringify({ email: nonAdminEmail, name: 'Browser Non Admin', password: nonAdminPass }) });
const nonAdminLogin = await (await fetch(`${B_PANEL_WEB}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: nonAdminEmail, password: nonAdminPass }) })).json();
check('the lane can mint a non-admin session to drive the redirect', !!nonAdminLogin.accessToken,
  nonAdminLogin.accessToken ? '' : JSON.stringify(nonAdminLogin).slice(0, 60));
if (nonAdminLogin.accessToken) {
  await ctx.addCookies(['immich_access_token', 'immich_auth_type', 'immich_is_authenticated'].map((name) => ({
    name, url: B_PANEL_WEB,
    value: name === 'immich_access_token' ? nonAdminLogin.accessToken : (name === 'immich_auth_type' ? 'password' : 'true'),
  })));
  await page.goto(sidecarRoot, { waitUntil: 'networkidle' });
  const sentToOwn = await page.waitForURL('**/immich-shared-albums/me*', { timeout: 15000 }).then(() => true).catch(() => false);
  check('a non-admin at the root is redirected to their own panel', sentToOwn, page.url());
  check('a non-admin is never offered the server panel',
    (await page.locator('text=Server settings and pairings').count()) === 0);
}

await browser.close();
const fails = results.filter(r => !r.ok);
console.log(`\n${fails.length === 0 ? '🎉 BROWSER PASS' : `💥 ${fails.length} BROWSER FAILURES`} (${results.length} checks)`);
process.exit(fails.length ? 1 : 0);
