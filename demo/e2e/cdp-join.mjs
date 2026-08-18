// Drive the banner join on the demo device's real Chrome via CDP.
// Deterministic replacement for coordinate taps: types the server address with
// per-key delay (visible in the recording), clicks the real Join/Accept/Open
// buttons, and waits for each page state. Usage:
//   adb -s emulator-5556 forward tcp:9223 localabstract:chrome_devtools_remote
//   node cdp-join.mjs <server-address>
import { chromium } from 'playwright';

// address of Joe's sidecar as reachable from the emulator — pass it in; never hardcode
// a LAN address here, this repo is public.
const ADDR = process.argv[2] || (process.env.LAN_IP ? `${process.env.LAN_IP}:8302` : null);
if (!ADDR) { console.error('usage: node cdp-join.mjs <host:port>   (or set LAN_IP)'); process.exit(1); }
const browser = await chromium.connectOverCDP('http://localhost:9223', { timeout: 120000 });
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('/share/'));
if (!page) { console.error('share page not found:', ctx.pages().map(p => p.url())); process.exit(1); }

// the banner lives in a shadow root and re-renders as album data loads:
// resolve host -> shadowRoot -> element fresh on EVERY step
const bannerEl = (sel) => {
  const host = document.querySelector('#immich-shared-albums-banner');
  return host ? (host.shadowRoot || host).querySelector(sel) : null;
};
await page.waitForFunction(`(${bannerEl.toString()})('input') != null`, null, { timeout: 30000 });
await page.waitForTimeout(1500); // let the banner settle after its last re-render
// type inside the page (no focus -> no soft keyboard -> no layout thrash on camera)
await page.evaluate(async ({ addr, fn }) => {
  const get = eval(`(${fn})`);
  for (let i = 1; i <= addr.length; i++) {
    const inp = get('input');
    if (inp) { inp.value = addr.slice(0, i); inp.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 110));
  }
}, { addr: ADDR, fn: bannerEl.toString() });
await page.waitForTimeout(800);
await page.evaluate((fn) => { eval(`(${fn})`)('button.join').click(); }, bannerEl.toString());
await page.waitForURL('**/sidecar/accept*', { timeout: 30000 });
console.log('accept page reached');

await page.waitForFunction(() => document.getElementById('who')?.textContent?.includes('Joining as'), null, { timeout: 20000 });
await page.waitForTimeout(1500);                 // viewer reads "Joining as Grandpa Joe"
await page.evaluate(() => document.getElementById('go').click());
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('Joined'), null, { timeout: 60000 });
console.log('joined');

await page.waitForFunction(() => {
  const b = document.getElementById('openapp');
  return b && b.textContent.includes('Open in Immich app') && !b.disabled;
}, null, { timeout: 90000 });
await page.waitForTimeout(1500);                 // viewer sees the button enable
// a scripted click lacks the user gesture Chrome requires for intent:// links
// (it would follow the Play Store fallback) - print the album id; the caller
// fires the same deeplink through adb instead
const albumId = await page.evaluate(() => {
  const href = document.getElementById('openapp')?.getAttribute('href') || '';
  const m = href.match(/albums\/([0-9a-f-]+)/);
  return m ? m[1] : '';
});
console.log('ALBUM_ID=' + albumId);
await browser.close();
