/**
 * web/pages.ts — the two HTML surfaces the sidecar serves: the admin PANEL and the
 * signed-out/signed-in ACCEPT_PAGE that turns a share link into a join.
 *
 * Both talk to <prefix>/join, which authenticates the caller's Immich session server-side
 * (web/auth.ts). The client-side checks here are for UX only — telling someone they need
 * to sign in before they fill a form, and asking for an album password when the origin
 * says one is required. Nothing here is a security control.
 */
import { CFG, ROUTE_PREFIX } from '../config.ts';
import { html, css, raw } from './tags.ts';

/**
 * The admin panel is a Preact app (src/web/panel/, bundled to panel.bundle.js). This is only the
 * shell it mounts into.
 *
 * Client-rendered on purpose: the panel is admin-only, behind auth, and every action it offers was
 * already a JSON call, so server-rendering would pre-paint one frame of a page nobody waits on —
 * and would mean compiling the components for the server too, which runs TypeScript directly and
 * cannot import .tsx. The accept page below is the opposite case and stays server-rendered.
 */
export const PANEL = () => html`
  <!doctype html>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${CFG.name} — shared albums</title>
  <style>
    ${raw(PANEL_CSS)}
  </style>
  <main>
    <div id="app"></div>
    <noscript>
      This page needs JavaScript. Everything it does — linking servers, unlinking them — is an admin action
      against this server's API, so there is nothing useful to show without it.
    </noscript>
  </main>
  <script type="module" src="${ROUTE_PREFIX}/panel.bundle.js"></script>
`;

/**
 * Only what inline style objects cannot express: the page ground, and focus/hover states. Every
 * other style in the panel lives with its component, in src/web/panel/theme.ts.
 */
const PANEL_CSS = css`
  body {
    margin: 0;
    font-family:
      Inter,
      -apple-system,
      sans-serif;
    background: #101216;
    color: #e5e7eb;
    display: grid;
    place-items: start center;
    min-height: 100vh;
  }
  main {
    width: min(560px, 92vw);
    padding: 40px 0;
  }
  input:focus {
    border-color: #4250af;
    box-shadow: 0 0 0 3px rgba(66, 80, 175, 0.25);
  }
  button:hover {
    filter: brightness(1.08);
  }
  noscript {
    color: #9aa0a6;
    font-size: 14px;
    line-height: 1.55;
  }
`;

/**
 * The joining page is a Preact app too (src/web/accept/, bundled to accept.bundle.js). This is
 * the shell it mounts into.
 *
 * Its own bundle, not the panel's: this page is public and must not download admin code. It IS
 * client-rendered despite being the public surface — everything it does (find who is signed in,
 * redeem the link, watch the album fill, hand over a deeplink) needs JS, so there is no useful
 * pre-JS state to render.
 */
export const ACCEPT_PAGE = () => html`
  <!doctype html>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Join shared album — ${CFG.name}</title>
  <style>
    ${raw(ACCEPT_CSS)}
  </style>
  <div class="card">
    <div class="logo">🔗</div>
    <div id="app" data-household="${CFG.name}"></div>
    <noscript>Joining needs JavaScript — it signs you in to your own server and redeems the link.</noscript>
  </div>
  <script type="module" src="${ROUTE_PREFIX}/accept.bundle.js"></script>
`;

/** Light/dark card styling, plus the states inline styles cannot express. */
const ACCEPT_CSS = css`
  body {
    margin: 0;
    font-family:
      Overpass,
      Inter,
      Roboto,
      -apple-system,
      sans-serif;
    background: #f8f9fa;
    color: #202124;
    display: grid;
    place-items: center;
    min-height: 100vh;
  }
  .card {
    width: min(440px, calc(100vw - 32px));
    box-sizing: border-box;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 28px;
    padding: 30px 26px 26px;
    text-align: center;
    box-shadow:
      0 1px 3px rgba(60, 64, 67, 0.15),
      0 8px 28px rgba(60, 64, 67, 0.15);
  }
  .logo {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    margin: 0 auto 16px;
    display: grid;
    place-items: center;
    background: linear-gradient(135deg, #4250af, #7c3aed);
    font-size: 26px;
    box-shadow: 0 2px 10px rgba(66, 80, 175, 0.35);
  }
  h1 {
    font-size: 19px;
    font-weight: 600;
    margin: 0 0 6px;
    letter-spacing: -0.01em;
  }
  p {
    color: #5f6368;
    font-size: 13.5px;
    line-height: 1.55;
    margin: 6px 0 18px;
  }
  button {
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    padding: 12px 36px;
    border: 0;
    border-radius: 999px;
    background: #4250af;
    color: #fff;
    cursor: pointer;
    transition:
      filter 0.15s,
      box-shadow 0.15s;
  }
  button:hover {
    filter: brightness(1.08);
    box-shadow: 0 2px 10px rgba(66, 80, 175, 0.4);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
    box-shadow: none;
  }
  button.busy {
    opacity: 0.85;
  }
  .cta {
    display: inline-block;
    background: #4250af;
    color: #fff;
    text-decoration: none;
    font-weight: 600;
    padding: 12px 30px;
    border-radius: 999px;
  }
  .pw {
    display: block;
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 14px;
    padding: 11px 16px;
    border-radius: 999px;
    border: 1px solid rgba(0, 0, 0, 0.15);
    margin: 0 0 14px;
    text-align: center;
  }
  .spin {
    display: inline-block;
    width: 14px;
    height: 14px;
    margin-right: 9px;
    vertical-align: -2px;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: isa-spin 0.8s linear infinite;
  }
  @keyframes isa-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .who {
    font-size: 12.5px;
    color: #4250af;
    margin: -6px 0 16px;
    line-height: 1.5;
  }
  .who a {
    color: #4250af;
  }
  .out {
    margin-top: 16px;
    font-size: 13px;
    color: #4250af;
    min-height: 20px;
    line-height: 1.5;
  }
  @media (prefers-color-scheme: dark) {
    body {
      background: #101216;
      color: #e8eaed;
    }
    .card {
      background: #1b1f26;
      border-color: rgba(255, 255, 255, 0.08);
      box-shadow:
        0 1px 3px rgba(0, 0, 0, 0.4),
        0 10px 32px rgba(0, 0, 0, 0.5);
    }
    p {
      color: #9aa0a6;
    }
    .who,
    .who a,
    .out {
      color: #a8c7fa;
    }
    button,
    .cta {
      background: #a8c7fa;
      color: #0d1b3d;
    }
  }
`;
