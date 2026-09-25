// Browser-level assertions for the banner + accept flows — the surfaces the API suite
// structurally cannot see. Runs headless against the mocks after the main suite.
// Env: CKEY (origin admin key). Exits non-zero on any failure.
import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';

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
  // Nothing is in flight before there is a session — the preview is not even asked for until then —
  // so the button must not claim it is checking albums.
  const goLabel = ((await page.locator('#go').textContent().catch(() => '')) || '').trim();
  check('and the button does not claim work that is not happening',
    /sign in/i.test(goLabel) && !/checking/i.test(goLabel), `label="${goLabel}"`);
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
// A choice row is a link whose affordance IS its shape: the chevron has to sit at the right end of
// the same line as the text. It rendered on its own line at the left edge while the layout moved
// into the `choice` class and the inline flex was dropped, which reads as a bullet, not a target.
{
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('a.choice')].map((a) => {
      const box = a.getBoundingClientRect();
      const chevron = a.lastElementChild?.getBoundingClientRect();
      return {
        text: (a.innerText || '').split('\n')[0],
        display: getComputedStyle(a).display,
        right: !!chevron && Math.round(chevron.right) > Math.round(box.right) - 40,
        inline: !!chevron && chevron.top >= box.top && chevron.top < box.bottom - 8,
      };
    })
  );
  check('each chooser row is a flex line with its chevron at the right end',
    rows.length > 0 && rows.every((r) => r.display === 'flex' && r.right && r.inline),
    JSON.stringify(rows));
}

// 6b. THE SERVER PANEL'S SETTINGS CARD saves the whole object at once, so writing one field can
//     silently reset the others — and "Store shared photos on this server" is the toggle that
//     decides whether a mirror is a hotlink stub or a real local copy. The API suite proves the
//     sidecar honours the setting once it is set; only a loaded page proves the checkbox reaches
//     the server, and only a reload proves the SAVED row (not the component's own state) is what
//     the person sees next.
{
  await page.goto(`${B_PANEL_WEB}/immich-shared-albums/admin`, { waitUntil: 'networkidle' });
  const storeLabel = 'Store shared photos on this server';
  const storeBox = () => page.locator(`label:has-text("${storeLabel}") input[type=checkbox]`);
  const settingsReady = await storeBox().waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true).catch(() => false);
  check('the server panel renders its settings card', settingsReady);
  if (settingsReady) {
    const joinBox = page.locator('label:has-text("Allow other Immich users to join albums") input[type=checkbox]');
    const ttlSelect = page.locator('label:has-text("Pairing links stay valid for") select');
    const before = { store: await storeBox().isChecked(), join: await joinBox.isChecked(), ttl: await ttlSelect.inputValue() };
    const savedSettings = () => page.waitForResponse(
      (r) => r.url().includes('/immich-shared-albums/settings') && r.request().method() === 'POST',
      { timeout: 30000 }).catch(() => null);
    const wrote = savedSettings();
    await storeBox().click();
    await wrote;
    const after = await page.evaluate(async () => (await fetch('/immich-shared-albums/settings')).json());
    check('toggling store-locally reaches the server', after.storeSharedAssetsLocally === !before.store,
      `clicked to ${!before.store}, server says ${after.storeSharedAssetsLocally}`);
    check('saving one setting leaves the other two alone',
      after.shareLinkJoin === before.join && String(after.pairingTtlMinutes) === before.ttl,
      `before join=${before.join} ttl=${before.ttl}; after join=${after.shareLinkJoin} ttl=${after.pairingTtlMinutes}`);
    await page.reload({ waitUntil: 'networkidle' });
    const persisted = await storeBox().waitFor({ state: 'visible', timeout: 20000 })
      .then(() => storeBox().isChecked()).catch(() => null);
    check('the toggle survives a reload', persisted === !before.store, `checked=${persisted}`);
    // Put the household back: every later stage shares it, and a household that stores copies is a
    // different shape from the one the rest of the lane asserts on.
    const restored = savedSettings();
    await storeBox().click();
    await restored;
    const ended = await page.evaluate(async () => (await fetch('/immich-shared-albums/settings')).json());
    check('the lane restores the setting it changed', ended.storeSharedAssetsLocally === before.store,
      `ended at ${ended.storeSharedAssetsLocally}, started at ${before.store}`);
  }
}

// The signed-out pages are the only ones whose stylesheet is built on its own, so they are where an
// un-inlined token import would show up: the accent button renders as plain black text. Assert the
// computed colour rather than the markup, because that is what a person sees.
{
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(sidecarRoot, { waitUntil: 'networkidle' });
  const cta = await anonPage.evaluate(() => {
    const a = document.querySelector('a[href="/auth/login"]');
    if (!a) return null;
    const cs = getComputedStyle(a);
    return { text: a.textContent.trim(), background: cs.backgroundColor, body: getComputedStyle(document.body).backgroundColor };
  });
  check('a signed-out page renders its theme, not bare HTML',
    !!cta && cta.background === 'rgb(66, 80, 175)' && cta.body !== 'rgba(0, 0, 0, 0)',
    cta ? `"${cta.text}" background=${cta.background} body=${cta.body}` : 'no sign-in link');
  await anon.close();
}

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

// 7. THE PANEL IS WHAT OFFERS A PERSON'S ALBUMS, and between two people matching is a pull. This is
//    the whole reunification surface, and it is invisible to the API suite: it needs a PAGE to be
//    loaded by a signed-in person, because a panel visit is the only moment the sidecar holds their
//    credential — the route that offers (`POST /me/albums/publish`) exists, and for a long time
//    nothing in the UI called it, which left matching unreachable for anyone who did not use an API
//    client. Driven in one context per household, deliberately: cookies are keyed by domain, not
//    port, so a shared context silently swaps the two Immich tokens and every check reads the wrong
//    person's panel.
const C_PANEL_WEB = process.env.C_PANEL_WEB || `http://localhost:${PORT('PORT_SIDECAR_C', 8302)}`;
const panelName = `panel offer ${Date.now()}`;
const panelText = async (p) => (await p.locator('body').innerText().catch(() => '')) || '';
/** Only the candidates section: the panel prints album names in three places, so finding one
 *  anywhere on the page says nothing about whether this list still offers it. */
const candidates = (t) => (t.split('Possible album reunions')[1] || '').split('Your shared albums')[0];
const seesPair = (t) => new RegExp(panelName).test(candidates(t));

// C is hardened like production by run-mock-e2e.sh (`passwordLogin.enabled = false`), which is why no
// lane has ever driven its panel — the panel needs a session, and there was no way to mint one. Open
// it for this case and put it back, so the hardening the rig exists to prove stays proven.
const cConfig = await (await fetch(`${C}/api/system-config`, { headers: { 'x-api-key': CKEY } })).json();
const systemConfig = async () => (await fetch(`${C}/api/system-config`, { headers: { 'x-api-key': CKEY } })).json();
// WAITED FOR, not assumed: Immich answers the PUT before the change is visible to a login, and a
// lane that assumes otherwise reports "C failed" — which reads like a broken product rather than a
// setting that had not been applied yet. The previous version checked nothing and slept nowhere.
const setPasswordLogin = async (enabled) => {
  const put = await fetch(`${C}/api/system-config`, { method: 'PUT',
    headers: { 'x-api-key': CKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...cConfig, passwordLogin: { ...cConfig.passwordLogin, enabled } }) });
  if (!put.ok) return `PUT answered ${put.status}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await systemConfig())?.passwordLogin?.enabled === enabled) return '';
    await new Promise((r) => setTimeout(r, 1000));
  }
  return `still ${enabled ? 'disabled' : 'enabled'} after 30s`;
};
const cWasHardened = cConfig.passwordLogin.enabled === false;
const toggleProblem = cWasHardened ? await setPasswordLogin(true) : '';

// BOUNDED RETRY, because the toggle above is applied asynchronously: Immich caches its system config,
// so a login issued the instant the PUT returns can still be refused with password login off. That is
// a race in the lane's own setup, not a product failure, and it reads as one failed check plus a
// crash on the missing token — so wait for the sign-in the lane needs rather than for the PUT.
const signIn = async (base) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await (await fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: B_EMAIL, password: B_PASS }) })).json();
    if (r?.accessToken) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return {};
};
const bLogin = await signIn(B_PANEL_WEB);
const cLogin = await signIn(C_PANEL_WEB);
check('the lane can sign in on both households\' panels', !!bLogin.accessToken && !!cLogin.accessToken,
  `${bLogin.accessToken ? 'B ok' : 'B failed'}, ${cLogin.accessToken ? 'C ok' : 'C failed'}` +
  (toggleProblem ? ` (C's password login: ${toggleProblem})` : ''));
// STOP CLEANLY. The rest of this lane drives C's panel, and a missing token used to crash the run on
// `addCookies` — one bad line, then no output at all for the thirty checks after it. A lane that
// cannot meet its precondition says so and exits; it does not disappear.
if (!bLogin.accessToken || !cLogin.accessToken) {
  console.log(`\n💥 STOPPING: the panels need a session${toggleProblem ? ` — C's password login: ${toggleProblem}` : ''}`);
  process.exit(1);
}

const bAlbum = await (await fetch(`${B_PANEL_WEB}/api/albums`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bLogin.accessToken}` },
  body: JSON.stringify({ albumName: panelName }) })).json();
const cAlbum = await api('/albums', { albumName: panelName });
check('each household owns half of a same-named album', !!bAlbum?.id && !!cAlbum?.id,
  `${bAlbum?.id ? 'B ok' : 'B failed'}, ${cAlbum?.id ? 'C ok' : 'C failed'}`);

const panelOf = async (base, token) => {
  const c = await browser.newContext();
  const p = await c.newPage();
  await c.addCookies(['immich_access_token', 'immich_auth_type', 'immich_is_authenticated'].map((name) => ({
    name, url: base,
    value: name === 'immich_access_token' ? token : (name === 'immich_auth_type' ? 'password' : 'true'),
  })));
  await p.goto(`${base}/immich-shared-albums/me`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => !/Loading/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  return { c, p };
};

const bPanel = await panelOf(B_PANEL_WEB, bLogin.accessToken);
await bPanel.p.waitForTimeout(3000);

// THE PANEL IS SUBSCRIBED TO THE LIVE CHANNEL, asserted from the server's side: the rig-only emit
// hook answers with how many panels are listening, so a subscription torn down early — the bug this
// route's cleanup had — reads as 0 here instead of as a page that quietly stops updating.
const emitted = await (await fetch(`${B_PANEL_WEB}/immich-shared-albums/test/emit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bLogin.accessToken}` },
  body: JSON.stringify({ type: 'shares' }),
})).json();
check('the open panel holds a live subscription', emitted?.panels >= 1, JSON.stringify(emitted));
check('the first person to open their panel sees no pair yet — matching is a pull',
  !seesPair(await panelText(bPanel.p)));

const cPanel = await panelOf(C_PANEL_WEB, cLogin.accessToken);
const appeared = await cPanel.p.waitForFunction(
  (n) => new RegExp(`Possible album reunions[\\s\\S]*?${n}`).test(document.body.innerText),
  panelName, { timeout: 30000 }).then(() => true).catch(() => false);
check('opening the other person\'s panel is enough — the pair appears, with no API call', appeared,
  (await panelText(cPanel.p)).split('\n').find((l) => l.includes(panelName)) || '(never appeared)');

// A panel's own match read refreshes the peer's index on the way past, so a hint emitted on EVERY
// refresh tells the page that just asked to ask again — an idle panel would spin forever and never
// land a fresh answer, which is how "Accept invite" failed to appear on an open page. Hints are
// counted on the server, so a page that quietly stops updating cannot hide behind a passing render.
const hintCount = async () => (await (await fetch(`${B_PANEL_WEB}/immich-shared-albums/sync/status`, {
  headers: { Authorization: `Bearer ${bLogin.accessToken}` } })).json()).hints;
const hintsBefore = await hintCount();
await bPanel.p.waitForTimeout(6000);
const hintsAfter = await hintCount();
check('an idle open panel does not hint itself in circles', hintsAfter - hintsBefore <= 2,
  `${hintsBefore} -> ${hintsAfter} over 6s with both panels open`);

// Withdrawing the half B offered must reach C: an offer of NOTHING is still an offer, and it is how
// the peer learns that everything this person had is gone.
const withdrew = await fetch(`${B_PANEL_WEB}/api/albums/${bAlbum.id}`, { method: 'DELETE',
  headers: { Authorization: `Bearer ${bLogin.accessToken}` } });
check('the lane can delete the half B offered', withdrew.ok, `delete -> ${withdrew.status}`);
await bPanel.p.reload({ waitUntil: 'domcontentloaded' });
await bPanel.p.waitForTimeout(3000);
await cPanel.p.reload({ waitUntil: 'domcontentloaded' });
await cPanel.p.waitForTimeout(3000);
check('so the pair is gone from the other person\'s list', !seesPair(await panelText(cPanel.p)));

// And now the case that a person who ends up owning NOTHING is still heard. B above owns plenty, so
// his offer simply got shorter; a household's loneliest member is the one whose panel stops offering
// entirely if the offer is skipped for an empty list, leaving the peer matching against albums that
// no longer exist. Driven as a freshly minted non-admin, who owns exactly one album and then none.
const soloName = `panel solo ${Date.now()}`;
const soloEmail = 'panel-solo@e2e.local';
const soloPass = 'panel-solo-pass-1';
await fetch(`${B_PANEL_WEB}/api/admin/users`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bLogin.accessToken}` },
  body: JSON.stringify({ email: soloEmail, name: 'Panel Solo', password: soloPass }) });
const soloLogin = await (await fetch(`${B_PANEL_WEB}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: soloEmail, password: soloPass }) })).json();
const soloAlbum = await (await fetch(`${B_PANEL_WEB}/api/albums`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${soloLogin.accessToken}` },
  body: JSON.stringify({ albumName: soloName }) })).json();
const cSoloAlbum = await api('/albums', { albumName: soloName });
check('a person with a single album, and the other half of it on the peer', !!soloLogin.accessToken && !!soloAlbum?.id && !!cSoloAlbum?.id,
  `${soloLogin.accessToken ? 'signed in' : 'no session'}, ${soloAlbum?.id ? 'album ok' : 'album failed'}, ${cSoloAlbum?.id ? 'peer half ok' : 'peer half failed'}`);

const soloPanel = await panelOf(B_PANEL_WEB, soloLogin.accessToken);
await soloPanel.p.waitForTimeout(3000);
await cPanel.p.reload({ waitUntil: 'domcontentloaded' });
await cPanel.p.waitForTimeout(3000);
check('a non-admin\'s own panel offers their album too, so the pair appears',
  new RegExp(`Possible album reunions[\\s\\S]*?${soloName}`).test(await panelText(cPanel.p)));

await fetch(`${B_PANEL_WEB}/api/albums/${soloAlbum.id}`, { method: 'DELETE',
  headers: { Authorization: `Bearer ${soloLogin.accessToken}` } });
await soloPanel.p.reload({ waitUntil: 'domcontentloaded' });
await soloPanel.p.waitForTimeout(3000);
check('with nothing left to offer, the panel still loads', !/Loading/.test(await panelText(soloPanel.p)));
await cPanel.p.reload({ waitUntil: 'domcontentloaded' });
await cPanel.p.waitForTimeout(3000);
check('and the peer stops matching against the album that is gone',
  !new RegExp(`Possible album reunions[\\s\\S]*?${soloName}`).test(await panelText(cPanel.p)));


// 8. The reunion round trip through the PANELS alone: one side invites — which shares its own album
//    with the other person, in Immich — the other accepts, and both lists drop the pair. The
//    inviter's row clears over the wire (`handleReunified`), which nothing local could observe.
const inviteName = `panel invite ${Date.now()}`;
const bInviteAlbum = await (await fetch(`${B_PANEL_WEB}/api/albums`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bLogin.accessToken}` },
  body: JSON.stringify({ albumName: inviteName }) })).json();
const cInviteAlbum = await api('/albums', { albumName: inviteName });
check('the lane can give both households a pair to reunite by invitation',
  !!bInviteAlbum?.id && !!cInviteAlbum?.id,
  `${bInviteAlbum?.id ? 'B ok' : 'B failed'}, ${cInviteAlbum?.id ? 'C ok' : 'C failed'}`);

// A PHOTO IN EACH HALF, because the point of a reunion is the photos and this lane used to reunite
// two EMPTY albums — which is how a merge that only ever reached one side passed every check here.
// Distinct bytes on each side, so "who ended up with what" is unambiguous.
const fixture = (n) => fs.readFileSync(new URL(`./fixtures/fx${n % 12}.jpg`, import.meta.url));
const putPhoto = async (base, auth, albumId, label, n) => {
  const fd = new FormData();
  fd.set('deviceAssetId', `browser-${label}-${Date.now()}`);
  fd.set('deviceId', 'browser-lane');
  fd.set('fileCreatedAt', '2024-03-01T10:00:00.000Z');
  fd.set('fileModifiedAt', '2024-03-01T10:00:00.000Z');
  fd.set('assetData', new Blob([Buffer.concat([fixture(n), crypto.randomBytes(8)])], { type: 'image/jpeg' }), `${label}.jpg`);
  const up = await (await fetch(`${base}/api/assets`, { method: 'POST', headers: auth, body: fd })).json();
  if (!up?.id) return null;
  // A preview must exist before it can be mirrored, exactly as the API suite waits for one.
  for (let i = 0; i < 30; i++) {
    if ((await fetch(`${base}/api/assets/${up.id}/thumbnail?size=preview`, { headers: auth })).ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await fetch(`${base}/api/albums/${albumId}/assets`, { method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [up.id] }) });
  return up.id;
};
const bPhoto = await putPhoto(B_PANEL_WEB, { Authorization: `Bearer ${bLogin.accessToken}` }, bInviteAlbum.id, 'b-half', 6);
const cPhoto = await putPhoto(C, { 'x-api-key': CKEY }, cInviteAlbum.id, 'c-half', 7);
check('each half holds one photo of its own, so the merge is observable', !!bPhoto && !!cPhoto,
  `${bPhoto ? 'B ok' : 'B failed'}, ${cPhoto ? 'C ok' : 'C failed'}`);

/** How many assets an album holds, and how many of them this account does NOT own (its stubs). */
const albumShape = async (base, auth, albumId, ownerId) => {
  const r = await (await fetch(`${base}/api/search/metadata`, { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ albumIds: [albumId], size: 200 }) })).json();
  const items = r?.assets?.items || [];
  return { total: items.length, stubs: items.filter((a) => a.ownerId !== ownerId).length };
};

/** Click the button labelled `label` in the row that names this album — the row is the smallest
 *  ancestor that mentions it, because the panel repeats the same two labels down the list. */
// The panel renders its reunions only once its own fetch lands, and that fetch refreshes the peer's
// index over iroh — a round trip, not a tick. A fixed sleep reads the page before it has an answer
// and blames the product; this waits for the answer.
const waitForRow = async (p, rowRegex, ms = 45000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Give THIS load its chance to answer before replacing it: the panel fetches on mount, and a
    // reload before that lands throws away the very response being waited for.
    const shown = await p
      .waitForFunction(
        (source) => new RegExp(source).test(document.body.innerText),
        rowRegex.source,
        { timeout: Math.min(15000, Math.max(1000, deadline - Date.now())) }
      )
      .then(() => true)
      .catch(() => false);
    if (shown) return true;
    await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(1000);
  }
  return false;
};

// Actions ask before they act, so a row's button opens a dialog and the dialog's button is what
// runs it. Clicking the row and walking away is the bug this helper exists to prevent.
const confirmDialog = async (p, label) => {
  const dialog = p.locator('[role=dialog]');
  if (!(await dialog.count())) return false;
  await dialog.getByRole('button', { name: label, exact: true }).click();
  return true;
};

/**
 * Is there a button labelled `label` in the row that names this album?
 *
 * Text-matching the page cannot answer this: the album name and a button label can sit in different
 * rows and still appear within a few hundred characters of each other, which is how a check passed
 * while the click that followed found nothing. The question is about the DOM's structure, so the page
 * is asked structurally.
 */
const rowHasButton = (p, label, name) =>
  p.evaluate(([label, name]) => {
    const buttons = [...document.querySelectorAll('button,a')].filter(x => new RegExp(label).test((x.textContent || '').trim()));
    return buttons.some(b => {
      for (let el = b, i = 0; el && i < 6; el = el.parentElement, i++)
        if ((el.innerText || '').includes(name)) return true;
      return false;
    });
  }, [label, name]).catch(() => false);

const waitForRowButton = async (p, label, name, ms = 90000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await rowHasButton(p, label, name)) return true;
    await p.waitForTimeout(2000);
    await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await p.waitForTimeout(2500);
  }
  return false;
};

// Why a click did not happen, in the check's own detail: the buttons present, and whether any of
// them had an ancestor naming the album. A bare false costs a whole round of guessing.
const clickDetail = (p, label, name) =>
  p.evaluate(([label, name]) => {
    const buttons = [...document.querySelectorAll('button,a')].filter(x => new RegExp(label).test(x.textContent || ''));
    const matched = buttons.some(b => {
      for (let el = b, i = 0; el && i < 6; el = el.parentElement, i++) if ((el.innerText || '').includes(name)) return true;
      return false;
    });
    return `present=${buttons.length} namesAlbum=${matched} texts=${JSON.stringify(buttons.slice(0, 3).map(b => (b.textContent || '').trim()))}`;
  }, [label, name]).catch(() => '(could not read the page)');

const clickInRow = (p, label, name) => p.evaluate(([label, name]) => {
  const buttons = [...document.querySelectorAll('button,a')]
    .filter(x => new RegExp(label).test(x.textContent || ''));
  let best = null, size = Infinity;
  for (const b of buttons) {
    for (let el = b, i = 0; el && i < 6; el = el.parentElement, i++) {
      const t = el.innerText || '';
      if (t.includes(name)) { if (t.length < size) { size = t.length; best = b; } break; }
    }
  }
  if (!best) return false;
  best.click();
  return true;
}, [label, name]);

// EVERY SWEEP IS HELD for the case below, on both households. The rig's one-second cadence cannot
// tell a nudge from a timer, and this case is the one that must be a nudge: with the loops held
// still, the invitation, the accept, both panel rows and BOTH halves of the union can only have
// been pushed. Ticks are read back at the end to prove the hold took — a lane that forgot to hold
// them would otherwise pass for the wrong reason.
const holdSweeps = async (base, auth, paused) =>
  await (await fetch(`${base}/immich-shared-albums/test/pause-sweeps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ paused }) })).json();
const bAuthForHooks = { Authorization: `Bearer ${bLogin.accessToken}` };
const cAuthForHooks = { Authorization: `Bearer ${cLogin.accessToken}` };
// `idle` is the server's own answer to "had the cycle already running finished?": without it a hold
// is only a promise about the NEXT tick, and a sweep in flight could still deliver the change.
const heldB = await holdSweeps(B_PANEL_WEB, bAuthForHooks, true);
const heldC = await holdSweeps(C_PANEL_WEB, cAuthForHooks, true);
const loopsHeld = [heldB, heldC].every((r) => r?.paused === true && r?.idle === true);
const ticksAtHold = {
  b: (await (await fetch(`${B_PANEL_WEB}/immich-shared-albums/sync/status`, { headers: bAuthForHooks })).json()).ticks,
  c: (await (await fetch(`${C_PANEL_WEB}/immich-shared-albums/sync/status`, { headers: cAuthForHooks })).json()).ticks,
};

// C looks first so its offer is in B's index; B is the household that invites.
await cPanel.p.goto(`${C_PANEL_WEB}/immich-shared-albums/me`, { waitUntil: 'domcontentloaded' });
await cPanel.p.waitForTimeout(3000);
await bPanel.p.goto(`${B_PANEL_WEB}/immich-shared-albums/me`, { waitUntil: 'domcontentloaded' });
const inviteRowShown = await waitForRowButton(bPanel.p, '^Invite ', inviteName);
check('a pair with nothing shared yet is offered an invitation', inviteRowShown,
  (await panelText(bPanel.p)).split('\n').filter(l => /^Invite /.test(l)).slice(0, 2).join(' | ') || '(none)');

check('Invite was clicked', await clickInRow(bPanel.p, '^Invite ', inviteName), await clickDetail(bPanel.p, '^Invite ', inviteName));
check('and it asked first, rather than sharing on the click alone', await confirmDialog(bPanel.p, 'Invite'));
// A page opened before a change needs the change PUSHED to it: the panel follows `/events`, so the
// waits below reload only where they are testing the fetch path itself, and the invitation case
// above deliberately does not reload at all.
check("the inviter's own row now waits on the other person",
  await waitForRow(bPanel.p, /waiting for them to accept/));

// NO RELOAD. The panel follows `/immich-shared-albums/events`, so an invitation that arrives while
// the page is open has to appear by itself. Reloading in this loop — which is what it used to do —
// passes for the wrong reason and would keep passing if the live channel never delivered at all.
let acceptOffered = false;
for (const deadline = Date.now() + 60000; Date.now() < deadline && !acceptOffered; ) {
  await cPanel.p.waitForTimeout(2000);
  acceptOffered = /Accept invite/.test(candidates(await panelText(cPanel.p)));
}
check('the other person is offered Accept invite on the page that was already open, with no reload',
  acceptOffered);
check('Accept invite was clicked', await clickInRow(cPanel.p, '^Accept invite', inviteName), await clickDetail(cPanel.p, '^Accept invite', inviteName));
check('and it asked first, rather than merging on the click alone', await confirmDialog(cPanel.p, 'Accept'));

// The accept must have DONE something before the list can be expected to clear: without this the
// failure reads as 'the list did not clear' when the truth is 'the accept never happened'.
const merged = await waitForRow(cPanel.p, /Reunited into/);
check('accepting merges the other half, as the panel says', merged,
  (await panelText(cPanel.p)).split('\n').find(l => /Reunited|Could not/.test(l)) || '(no notice)');

const cleared = await waitForRow(bPanel.p, new RegExp(`^(?!.*${inviteName}).*$`, 's'), 60000).catch(() => false);
const goneNow = !new RegExp(inviteName).test(candidates(await panelText(bPanel.p)));
const survivors = candidates(await panelText(bPanel.p))
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.includes(inviteName))
  .slice(0, 3);
check("and the pair leaves the inviter's list once it is done", goneNow,
  survivors.length ? `still listed: ${JSON.stringify(survivors)}` : '(the name is gone from the candidates)');

// THE POINT OF A REUNION: both households end up holding the union, each owning its own half and
// holding the other's as a stub (design doc §2). Asserted on BOTH albums, because checking only the
// accepting side is what let a one-way merge pass — the inviter's album never changed and nothing
// here looked at it.
{
  const bMe = await (await fetch(`${B_PANEL_WEB}/api/users/me`, { headers: { Authorization: `Bearer ${bLogin.accessToken}` } })).json();
  const cMe = await (await fetch(`${C}/api/users/me`, { headers: { 'x-api-key': CKEY } })).json();
  const bAuth = { Authorization: `Bearer ${bLogin.accessToken}` };
  // Fifteen seconds, with every loop held: the two halves arrive by push and by the accept's own
  // reconcile, so anything still missing after this could not have been swept in behind us.
  const settle = async (base, auth, albumId, ownerId) => {
    for (let i = 0; i < 30; i++) {
      const shape = await albumShape(base, auth, albumId, ownerId);
      if (shape.total >= 2) return shape;
      await new Promise((r) => setTimeout(r, 500));
    }
    return albumShape(base, auth, albumId, ownerId);
  };
  // C accepted, so C's own album is the one that adopted: it holds B's half as a stub.
  const cShape = await settle(C, { 'x-api-key': CKEY }, cInviteAlbum.id, cMe.id);
  // B invited, so B's own album is completed by C's half ARRIVING — the push this case exists for.
  const bShape = await settle(B_PANEL_WEB, bAuth, bInviteAlbum.id, bMe.id);
  check('the accepting household holds the union — its own photo plus the other half as a stub',
    cShape.total === 2 && cShape.stubs === 1, JSON.stringify(cShape));
  check('and so does the INVITING household — a reunion merges both ways, with no sweep to do it',
    bShape.total === 2 && bShape.stubs === 1, JSON.stringify(bShape));
}

// The ticks are read BEFORE the release: releasing is what lets a tick fire, so reading afterwards
// would fold the first tick of the resumed loop into a claim about the held ones.
const ticksAfter = {
  b: (await (await fetch(`${B_PANEL_WEB}/immich-shared-albums/sync/status`, { headers: bAuthForHooks })).json()).ticks,
  c: (await (await fetch(`${C_PANEL_WEB}/immich-shared-albums/sync/status`, { headers: cAuthForHooks })).json()).ticks,
};
const loopsReleased = (await holdSweeps(B_PANEL_WEB, bAuthForHooks, false)).paused === false
  && (await holdSweeps(C_PANEL_WEB, cAuthForHooks, false)).paused === false;
check('every sweep was held through the reunion, and idle when it was held', loopsHeld && loopsReleased,
  `held=${JSON.stringify([heldB, heldC])} released=${loopsReleased} ticks ${JSON.stringify(ticksAtHold)} -> ${JSON.stringify(ticksAfter)}`);
check('and not one of them ticked while the reunion completed',
  JSON.stringify(ticksAtHold) === JSON.stringify(ticksAfter),
  `${JSON.stringify(ticksAtHold)} -> ${JSON.stringify(ticksAfter)} (every loop, not just the watcher)`);

// The invite case above is the last to drive them, so the panels close here.
await soloPanel.c.close();
await bPanel.c.close();
await cPanel.c.close();

if (cWasHardened) {
  await setPasswordLogin(false);
  const restored = await (await fetch(`${C}/api/system-config`, { headers: { 'x-api-key': CKEY } })).json();
  check("C's password-login hardening is back on after the case", restored.passwordLogin.enabled === false,
    restored.passwordLogin.enabled === false ? '' : 'the rig was left with C\'s password login open');
}

await browser.close();
const fails = results.filter(r => !r.ok);
console.log(`\n${fails.length === 0 ? '🎉 BROWSER PASS' : `💥 ${fails.length} BROWSER FAILURES`} (${results.length} checks)`);
process.exit(fails.length ? 1 : 0);
