// verify-panel-browser.mjs — load the Rust sidecar's admin panel in a REAL browser, signed in.
//
//   node rust/verify-panel-browser.mjs [SIDECAR_URL] [EMAIL] [PASSWORD]
//
// The sidecar is a FRONT for Immich, so everything goes through one origin — that is what makes the
// Immich session cookie apply to the panel, and it is how a real install is reached. Pointing the
// browser at Immich directly would test an arrangement nobody deploys.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8398';
const EMAIL = process.argv[3] || 'admin@e2e.local';
const PASS = process.argv[4] || 'e2e-admin-pass-1';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  // Sign in through the SIDECAR, so the cookie lands on the origin the panel is served from.
  const login = await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASS },
  });
  check('signs in through the sidecar', login.status() === 201, `status ${login.status()}`);
  if (login.status() !== 201) throw new Error('cannot continue without a session');

  const res = await page.goto(`${BASE}/immich-shared-albums/admin`, { waitUntil: 'networkidle' });
  check('panel answers 200', res.status() === 200, `status ${res.status()}`);

  // A blank page is the failure this catches: the shell is ~400 bytes and everything visible is
  // rendered by panel.js, so a broken bundle looks like a successful 200 with nothing in it.
  const text = (await page.locator('body').innerText()).trim();
  check('panel rendered content, not an empty shell', text.length > 0, `${text.length} chars`);

  // The REAL label. deploy/INSTALL-AI.md and SETUP.md told operators to look for a button that
  // does not exist, so this asserts the name the install docs use.
  const createLink = page.getByRole('button', { name: /create a link/i });
  await createLink.waitFor({ state: 'visible', timeout: 10_000 });
  check('offers the "Create a link" button the install docs name', await createLink.isVisible());

  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('browser run completed', false, e.message);
} finally {
  await page.screenshot({ path: '/tmp/isa-panel.png', fullPage: true }).catch(() => {});
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
