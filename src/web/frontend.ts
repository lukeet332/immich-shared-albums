/**
 * web/frontend.ts — every human-facing surface this addon serves, in one table.
 *
 * The point is legibility: "what pages exist, and who may see them" should be answerable by
 * reading one screen, not by tracing a 300-line if-chain. No router library and no matching
 * beyond an exact path lookup — anything needing patterns, streaming or bodies stays in
 * server.ts, which is also where the ordering rules that cannot move are documented.
 *
 * `admin: true` means the caller must be a signed-in Immich admin; the panel is the only one,
 * because it is the only surface that acts on the server rather than describing it. The rest are
 * public on purpose: the accept page has to be reachable by someone who has not signed in yet
 * (that is its whole job), and the two scripts are code, not data — every route they call
 * authenticates on its own.
 */
import { ROUTE_PREFIX } from '../config.ts';
import { PANEL, ACCEPT_PAGE } from './pages.ts';
import { BANNER_JS } from './banner.ts';
import { PANEL_BUNDLE, ACCEPT_BUNDLE } from './panel-bundle.ts';

const HTML = 'text/html';
const JS = 'application/javascript';

export type Surface = {
  /** Content-Type to send. */
  type: string;
  /** Rendered on each request, so CFG and state changes are picked up without a restart. */
  body: () => string;
  /** Requires a signed-in Immich admin. */
  admin?: true;
  /** What the sign-in page should say the caller was trying to do. */
  action?: string;
};

export const SURFACES: Record<string, Surface> = {
  // The admin panel. A shell that mounts the Preact app in panel.bundle.js.
  [ROUTE_PREFIX]: { type: HTML, body: PANEL, admin: true, action: 'manage shared albums' },
  [`${ROUTE_PREFIX}/`]: { type: HTML, body: PANEL, admin: true, action: 'manage shared albums' },
  // Turns a share link into a join. Must be reachable while signed out.
  [`${ROUTE_PREFIX}/accept`]: { type: HTML, body: ACCEPT_PAGE },
  // Injected into another server's share page so a visitor can type their own server address.
  [`${ROUTE_PREFIX}/banner.js`]: { type: JS, body: () => BANNER_JS },
  // The two compiled apps. Separate bundles so the public joining page carries no admin code.
  [`${ROUTE_PREFIX}/panel.bundle.js`]: { type: JS, body: () => PANEL_BUNDLE },
  [`${ROUTE_PREFIX}/accept.bundle.js`]: { type: JS, body: () => ACCEPT_BUNDLE },
};

export const surfaceFor = (path: string): Surface | undefined => SURFACES[path];
