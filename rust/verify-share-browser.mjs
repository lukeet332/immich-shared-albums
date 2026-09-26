// verify-share-browser.mjs — INSTALL-AI.md's VERIFY step 2, in a real browser.
//
//   node rust/verify-share-browser.mjs [SIDECAR_URL]
//
// "Any Immich share link opened in a browser shows the 'Join shared album with your server?' card."
// The shell the sidecar serves is ~770 bytes with no card in it — the card is rendered by share.js,
// which renames #share-app to #immich-shared-albums-banner and mounts into it. So the only thing
// that can answer this claim is a browser: a 200 from curl proves nothing about it.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8391';
// The rig's host port map, the same one demo/e2e uses: 2384 here is THIS host's shift, and a
// default checkout (or CI) runs the mocks on 2284-2286.
const PORT = (name, dflt) => process.env[name] || dflt;
const IMMICH = `http://localhost:${PORT('PORT_IMMICH_B', 2284)}`;
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// The key comes from the ENVIRONMENT, exactly as the e2e suite takes it (the rig exports BKEY):
// a lane has no business reading a credential off disk and putting it in a request header.
//   BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-) node rust/<this lane>.mjs
const BKEY = process.env.BKEY || process.env.B_SIDECAR_API_KEY;
if (!BKEY) {
  console.error('BKEY is required — export the rig\'s household-B key first:');
  console.error("  BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-) node rust/<lane>");
  process.exit(2);
}

const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const api = async (path, body) => (await fetch(`${IMMICH}/api${path}`, {
  method: 'POST', headers: { 'x-api-key': BKEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const albumName = `Share card ${Date.now()}`;
const album = await api('/albums', { albumName });
const link = await api('/shared-links', { type: 'ALBUM', albumId: album.id, allowUpload: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

try {
  const res = await page.goto(`${BASE}/share/${link.key}`, { waitUntil: 'networkidle' });
  check('the share link answers', res.status() === 200, `status=${res.status()}`);

  // The banner id only exists once share.js has mounted — that rename IS the proof the bundle ran.
  const card = page.locator('#immich-shared-albums-banner .card');
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  check('the join card renders', await card.isVisible());

  // The album name is CONTRACT DATA, not displayed text: Share.tsx reads data-album-name and puts
  // it in the join payload (`{v:2, e, key, a}`), so the peer learns which album is being joined. It
  // deliberately renders a generic prompt, so asserting the name is visible would be asserting a
  // behaviour the UI does not have.
  const carried = await page.locator('#immich-shared-albums-banner').getAttribute('data-album-name');
  check('the card carries the album name to the peer', carried === albumName, `data-album-name=${JSON.stringify(carried)}`);

  const body = await page.locator('#immich-shared-albums-banner').innerText();
  check('and asks the join question', /Join shared album with your server\?/.test(body), JSON.stringify(body.slice(0, 60)));

  check('it offers the server-address field', await page.locator('#immich-shared-albums-banner input').first().isVisible());
  check('it offers a join button', await page.locator('#immich-shared-albums-banner button.join').isVisible());
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('the browser run completed', false, e.message);
} finally {
  await page.screenshot({ path: '/tmp/isa-share-card.png', fullPage: true }).catch(() => {});
  await browser.close();
}

const failed = checks.filter(c => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
