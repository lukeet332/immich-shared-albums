// Browser-level assertions for the banner + accept flows — the surfaces the API suite
// structurally cannot see. Runs headless against the mocks after the main suite.
// Env: CKEY (origin admin key). Exits non-zero on any failure.
import { chromium } from 'playwright';

const C = 'http://localhost:2285';
// The share page must be browsed on an address B's CONTAINER can also reach — the
// banner embeds the page's own host into the join payload for the redeem.
const SHARE_HOST = process.env.SHARE_HOST || 'http://host.docker.internal:8302';
const B_ADDR = process.env.B_ADDR || 'host.docker.internal:8301';                // typed into the banner
const B_PANEL_WEB = process.env.B_PANEL_WEB || 'http://localhost:8301';
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

const browser = await chromium.launch({ args: ['--disable-features=HttpsUpgrades,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,PrivateNetworkAccessChecks'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// 1. banner renders over the share page
await page.goto(`${SHARE_HOST}${SHARE_PATH}`, { waitUntil: 'networkidle' });
const banner = page.locator('#immich-shared-albums-banner .card');
check('banner renders on the share page', await banner.isVisible().catch(() => false));

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
const reached = await page.waitForURL('**/sidecar/accept*', { timeout: 20000 }).then(() => true).catch(() => false);
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
await page.locator('#go').click();
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('Joined'), null, { timeout: 60000 }).catch(() => {});
check('join completes fast (async join)', (await page.locator('#out').textContent().catch(() => '')).includes('Joined'));
const btnReady = await page.waitForFunction(() => {
  const b = document.getElementById('openapp');
  return b && b.textContent.includes('Open in Immich app');
}, null, { timeout: 90000 }).then(() => true).catch(() => false);
check('app button enables once the album is filled (gated deeplink)', btnReady);

await browser.close();
const fails = results.filter(r => !r.ok);
console.log(`\n${fails.length === 0 ? '🎉 BROWSER PASS' : `💥 ${fails.length} BROWSER FAILURES`} (${results.length} checks)`);
process.exit(fails.length ? 1 : 0);
