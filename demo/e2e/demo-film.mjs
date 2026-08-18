// Two-sided demo: sender's album -> share link -> banner -> join -> recipient's album
// -> live finale (sender adds a photo, it appears on the recipient within seconds).
// Fast cuts, no long pauses. Env: SHARE_URL, C_ALBUM (id), CKEY, PHOTO (path to finale jpg).
import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SHARE_URL = process.env.SHARE_URL;
const OUT = process.env.OUT || './video';
// cookies are domain-scoped and port-blind: keep C on localhost and B on the LAN IP
// so their sessions can coexist in one browser context. LAN_IP is this machine's address
// on the local network — never hardcode it, this repo is public.
const LAN_IP = process.env.LAN_IP;
if (!LAN_IP) {
  console.error("set LAN_IP to this machine's LAN address, e.g. LAN_IP=$(ipconfig getifaddr en0)");
  process.exit(1);
}
const C = 'http://localhost:2285', C_WEB = 'http://localhost:2285';
const B_PANEL = `http://${LAN_IP}:8301`, B_WEB = `http://${LAN_IP}:2284`;
const ADDR_TYPED = `${LAN_IP}:8301`;

const browser = await chromium.launch({ args: ['--disable-features=HttpsUpgrades,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable,LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,PrivateNetworkAccessChecks'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  colorScheme: 'dark',
});
const page = await ctx.newPage();
// off-camera: mint sessions via the API and inject the cookies — no filmed logins
const inject = async (base, email, password) => {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const { accessToken } = await r.json();
  if (!accessToken) throw new Error(`login failed for ${email} at ${base}`);
  await ctx.addCookies(['immich_access_token', 'immich_auth_type', 'immich_is_authenticated'].map((name) => ({
    name, url: base,
    value: name === 'immich_access_token' ? accessToken : (name === 'immich_auth_type' ? 'password' : 'true'),
  })));
};
console.log('scene 0: sessions injected off-camera');
await inject(C_WEB, 'admin@household-c.local', 'demo-household-c-1');
await inject(B_PANEL, 'demo@household-b.local', 'demo-household-b-1'); // domain covers both B ports

console.log("scene 1: SENDER — Grandpa Joe's album on HIS server");
await page.goto(`${C_WEB}/albums/${process.env.C_ALBUM}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2600);

console.log('scene 2: RECIPIENT — the share link, banner over the album');
await page.goto(SHARE_URL, { waitUntil: 'networkidle' });
await page.locator('#immich-shared-albums-banner .card').waitFor({ state: 'visible' });
await page.waitForTimeout(2000);
const input = page.locator('#immich-shared-albums-banner input');
await input.click();
await input.pressSequentially(ADDR_TYPED, { delay: 42 });
if (await input.inputValue() !== ADDR_TYPED) await input.fill(ADDR_TYPED);
await page.waitForTimeout(600);
await page.locator('#immich-shared-albums-banner button.join').click();

console.log('scene 3: accept page — already knows who I am');
await page.waitForURL('**/sidecar/accept*', { timeout: 20000 });
await page.waitForFunction(() => document.getElementById('who')?.textContent?.includes('Joining as'), null, { timeout: 20000 });
await page.waitForTimeout(1800);
await page.locator('#go').click();
await page.waitForFunction(() => document.getElementById('out')?.textContent?.includes('Joined'), null, { timeout: 120000 });
await page.waitForTimeout(2200);

console.log("scene 4: the album, native in the recipient's own Immich");
await page.goto(`${B_WEB}/albums`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.locator('text=Summer at the lake').first().click();
await page.waitForTimeout(2800);

console.log('scene 5: FINALE — sender adds a photo; watch it arrive');
{
  const bytes = Buffer.concat([fs.readFileSync(process.env.PHOTO), crypto.randomBytes(8)]);
  const fd = new FormData();
  fd.set('deviceAssetId', `demo-${Date.now()}`); fd.set('deviceId', 'demo');
  fd.set('fileCreatedAt', new Date().toISOString()); fd.set('fileModifiedAt', new Date().toISOString());
  fd.set('assetData', new Blob([bytes], { type: 'image/jpeg' }), 'one-more.jpg');
  const up = await (await fetch(`${C}/api/assets`, { method: 'POST', headers: { 'x-api-key': process.env.CKEY }, body: fd })).json();
  // wait for the preview so the very first sync attempt succeeds on camera
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${C}/api/assets/${up.id}/thumbnail?size=preview`, { headers: { 'x-api-key': process.env.CKEY } });
    if (r.ok) break; await new Promise(r2 => setTimeout(r2, 1500));
  }
  await fetch(`${C}/api/albums/${process.env.C_ALBUM}/assets`, { method: 'PUT',
    headers: { 'x-api-key': process.env.CKEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [up.id] }) });
}
await page.waitForTimeout(11000);      // sender's watcher tick + push + materialise
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

await ctx.close();
await browser.close();
console.log(`done — video in ${OUT}`);
