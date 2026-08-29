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
import { DIST, panelPage, acceptPage, mePage } from './assets.ts';

const HTML = 'text/html';
const JS = 'application/javascript';
const CSS_TYPE = 'text/css';

export type Surface = {
  /** Content-Type to send. */
  type: string;
  /** Rendered on each request, so CFG and state changes are picked up without a restart. */
  body: () => string;
  /** Requires a signed-in Immich admin. */
  admin?: true;
  /** Requires a signed-in Immich user (any). The page then scopes everything to the caller's own
   *  id server-side — the per-user panel. Distinct from `admin`, which also requires isAdmin. */
  signedIn?: true;
  /** What the sign-in page should say the caller was trying to do. */
  action?: string;
};

export const SURFACES: Record<string, Surface> = {
  [ROUTE_PREFIX]: { type: HTML, body: panelPage, admin: true, action: 'manage shared albums' },
  [`${ROUTE_PREFIX}/`]: { type: HTML, body: panelPage, admin: true, action: 'manage shared albums' },
  [`${ROUTE_PREFIX}/me`]: { type: HTML, body: mePage, signedIn: true, action: 'see your shared albums' },
  [`${ROUTE_PREFIX}/me/`]: { type: HTML, body: mePage, signedIn: true, action: 'see your shared albums' },
  [`${ROUTE_PREFIX}/accept`]: { type: HTML, body: acceptPage },
  ...Object.fromEntries(
    Object.entries(DIST).map(([name, content]) => [
      `${ROUTE_PREFIX}/assets/${name}`,
      { type: name.endsWith('.js') ? JS : CSS_TYPE, body: () => content },
    ])
  ),
};

export const surfaceFor = (path: string): Surface | undefined => SURFACES[path];
