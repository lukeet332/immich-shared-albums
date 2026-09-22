// rust/verify-share.mjs — the join card over the native album, served by the Rust sidecar.
// Mirrors the banner half of demo/e2e/browser-test.mjs.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(REPO + '/package.json');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:9400';
const SHARE_KEY = fs.readFileSync('/tmp/sharekey', 'utf8').trim();
const SHARE_URL = `${BASE}/share/${SHARE_KEY}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- ?native=1 must reach IMMICH untouched ----
const native = await fetch(`${BASE}/share/${SHARE_KEY}?native=1`);
const nativeBody = await native.text();
check('?native=1 passes through to Immich', native.status === 200, `status=${native.status}`);
check(
  'and none of our markup is on it',
  !nativeBody.includes('immich-shared-albums-banner'),
  `${nativeBody.length} bytes`
);

// ---- the join document itself ----
const doc = await fetch(SHARE_URL);
const docBody = await doc.text();
check('the share document is served', doc.status === 200 && docBody.includes('data-origin-endpoint'));
check('its tokens are all substituted', !/%%[A-Z]+%%/.test(docBody));
check('it names the album from Immich', docBody.includes('share verify'), docBody.match(/<title>([^<]*)</)?.[1]);

const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();
const frameStatuses = [];
const failed = [];
page.on('response', r => {
  if (r.url().includes('?native=1')) frameStatuses.push(r.status());
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(BASE, '').slice(0, 60)}`);
});

await page.goto(SHARE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.screenshot({ path: '/tmp/explore/rust-share-banner.png', fullPage: true }).catch(() => {});

// The DOM contract the browser lane drives.
const banner = await page.evaluate(() => {
  const b = document.querySelector('#immich-shared-albums-banner');
  if (!b) return null;
  return {
    card: !!b.querySelector('.card'),
    join: !!b.querySelector('button.join'),
    input: !!b.querySelector('input'),
    dismiss: !!b.querySelector('.dismiss'),
    heading: b.querySelector('h2')?.textContent || '',
    iframe: document.querySelector('iframe.native-album')?.getAttribute('src') || null,
  };
});
check('the join card renders over the album', !!banner, banner ? banner.heading : 'no #immich-shared-albums-banner');
check('the card is complete (card, input, Join, dismiss)', !!banner?.card && !!banner?.input && !!banner?.join && !!banner?.dismiss);
check(
  'the heading is the documented one',
  /Join shared album with your server/i.test(banner?.heading || ''),
  banner?.heading
);
check(
  'the native album is framed behind it, via ?native=1',
  (banner?.iframe || '').includes('native=1'),
  String(banner?.iframe).slice(0, 60)
);
check('the framed document really loaded (not a 404 shell)', frameStatuses.some(s => s === 200), `statuses=${frameStatuses.join(',')}`);
check('no failed requests on the share page', failed.length === 0, failed.slice(0, 3).join(' | '));

// ---- dismiss hands over to Immich's own page ----
if (banner?.dismiss) {
  await page.locator('#immich-shared-albums-banner .dismiss').click();
  const wentNative = await page
    .waitForURL('**native=1**', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('dismissing the card hands over to the native share page', wentNative, page.url().slice(0, 70));
  check('and nothing of ours is left on it', (await page.locator('#immich-shared-albums-banner').count()) === 0);
}

console.log(`\n${results.every(r => r.ok) ? '✅ ALL PASS' : '❌ FAILURES'} (${results.filter(r => r.ok).length}/${results.length})`);
await browser.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
