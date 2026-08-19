// Films the full banner-join UX against the mocks:
// sign-in -> share page + banner -> type server -> accept page -> join (spinner) -> mirror album.
// Usage: node film-join.mjs <share-url> [joiner-panel] [out-dir]
import { chromium } from 'playwright';

const SHARE_URL = process.argv[2];
const B_PANEL = process.argv[3] || 'http://localhost:8301';
const OUT = process.argv[4] || './video';
const B_EMAIL = process.env.B_EMAIL || 'demo@household-b.local';
const B_PASS = process.env.B_PASS || 'demo-household-b-1';

const browser = await chromium.launch({ args: ['--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,PrivateNetworkAccessChecks'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  colorScheme: 'dark',
});
const page = await ctx.newPage();

console.log('scene 0: sign in to the joiner\'s own Immich (session for the per-user join)');
await page.goto(`${B_PANEL}/auth/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email], input[name=email], #email', B_EMAIL);
await page.fill('input[type=password], input[name=password], #password', B_PASS);
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);

console.log('scene 1: the shared link — banner over the working share page');
await page.goto(SHARE_URL, { waitUntil: 'networkidle' });
await page.waitForSelector('#immich-shared-albums-banner', { state: 'attached' });
await page.locator('#immich-shared-albums-banner .card').waitFor({ state: 'visible' });
await page.waitForTimeout(3000);

console.log('scene 2: typing my own server address');
await page.waitForTimeout(2000);
const input = page.locator('#immich-shared-albums-banner input');
await input.click();
const addr = B_PANEL.replace(/^https?:\/\//, '');
await input.pressSequentially(addr, { delay: 55 });
if (await input.inputValue() !== addr) await input.fill(addr);
await page.waitForTimeout(900);

console.log('scene 3: Join -> pre-flight -> accept page (already signed in)');
await page.locator('#immich-shared-albums-banner button.join').click();
await page.waitForURL('**/immich-shared-albums/accept*', { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('who')?.textContent?.includes('Joining as'), null, { timeout: 20000 });
await page.waitForTimeout(2500);

console.log('scene 4: Accept & join (spinner while photos materialise)');
await page.locator('#go').click();
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('Joined'), null, { timeout: 120000 });
await page.waitForTimeout(3000);

console.log('scene 5: the album, native in my own Immich');
await page.goto(`${B_PANEL}/albums`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const albumCard = page.locator('a[href*="/albums/"]').first();
await albumCard.click().catch(() => {});
await page.waitForTimeout(5000);

await ctx.close();
await browser.close();
console.log(`done — video in ${OUT}`);
