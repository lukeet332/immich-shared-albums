// rust/verify-share.mjs — the join card over the native album, served by the Rust sidecar.
// Mirrors the banner half of demo/e2e/browser-test.mjs.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(REPO + '/package.json');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:9400';
// The key comes from the caller, not from a file this lane hopes exists: `/tmp/sharekey` was written
// by hand once, so a fresh checkout failed at import with ENOENT before any check ran.
const SHARE_KEY = process.env.SHARE_KEY || '';
if (!SHARE_KEY) {
  console.error('SHARE_KEY is required — the share key of an album on the household this sidecar fronts.');
  console.error('Create one with the rig household key, start the sidecar fronting it, then run:');
  console.error("  KEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)");
  console.error('  SHARE_KEY=$(curl -s -X POST http://localhost:2384/api/shared-links -H "x-api-key: $KEY" \\');
  console.error("    -H 'Content-Type: application/json' \\");
  console.error("    -d '{\"type\":\"ALBUM\",\"albumId\":\"<album id>\",\"allowUpload\":true}' | python3 -c 'import json,sys;print(json.load(sys.stdin)[\"key\"])')");
  console.error('  BASE=http://localhost:9400 SHARE_KEY=$SHARE_KEY node rust/verify-share.mjs');
  process.exit(2);
}
// The album's NAME is the caller's as well, for the same reason the key is: this check used to assert
// the literal "share verify", so the lane only passed against whatever album one developer seeded.
const SHARE_ALBUM = process.env.SHARE_ALBUM || '';
if (!SHARE_ALBUM) {
  console.error('SHARE_ALBUM is required — the album name the share link points at.');
  process.exit(2);
}
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
check('it names the album from Immich', docBody.includes(SHARE_ALBUM), docBody.match(/<title>([^<]*)</)?.[1]);

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
// Under rust/target/, which exists and is gitignored: /tmp/explore was a scratch directory nothing
// creates, so the screenshot was silently lost behind the `.catch`.
fs.mkdirSync(`${REPO}/rust/target`, { recursive: true });
await page
  .screenshot({ path: `${REPO}/rust/target/rust-share-banner.png`, fullPage: true })
  .catch((e) => console.log(`  (screenshot not written: ${e.message})`));

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
