// Films the banner-join UX: share page -> banner -> accept page -> joined.
import { chromium } from 'playwright';

const SHARE_URL = process.argv[2];
const B_PANEL = process.argv[3] || 'http://192.168.0.11:8301';
const OUT = process.argv[4] || './video';

const browser = await chromium.launch({ args: ['--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,PrivateNetworkAccessChecks'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  colorScheme: 'dark',
});
const page = await ctx.newPage();

console.log('scene 1: share page with banner');
await page.goto(SHARE_URL, { waitUntil: 'networkidle' });
await page.waitForSelector('#immich-shared-albums-banner', { state: 'attached' });
await page.locator('#immich-shared-albums-banner .card').waitFor({ state: 'visible' });
await page.waitForTimeout(3000);

console.log('scene 2: typing household address');
await page.waitForTimeout(2500); // let the SPA finish its post-load churn
const input = page.locator('#immich-shared-albums-banner input');
await input.click();
await input.pressSequentially(B_PANEL, { delay: 45 });
if (await input.inputValue() !== B_PANEL) await input.fill(B_PANEL); // atomic repair if SPA ate keystrokes
await page.waitForTimeout(1000);

console.log('scene 3: join -> accept page');
await page.locator('#immich-shared-albums-banner button.join').click();
try {
  await page.waitForSelector('#go', { timeout: 15000 });
} catch (e) {
  console.log('LANDED ON:', page.url());
  await page.screenshot({ path: OUT + '/debug-landed.png' });
  throw e;
}
await page.waitForTimeout(2200);

console.log('scene 4: accept');
await page.click('#go');
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('Joined'), null, { timeout: 60000 });
await page.waitForTimeout(3500);

const screenshotPath = OUT + '/accept-success.png';
await page.screenshot({ path: screenshotPath });
await ctx.close();
await browser.close();
console.log('done — video in', OUT);
