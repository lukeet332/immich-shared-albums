/** web/frontend.ts — every human-facing surface this addon serves, in one table. See http-router.md. */
import { ROUTE_PREFIX } from '../config.ts';
import { PANEL_SHELL, ACCEPT_SHELL } from './pages.ts';
import { BANNER_JS } from './banner.ts';
import { PANEL_BUNDLE, ACCEPT_BUNDLE } from './panel-bundle.ts';

const HTML = 'text/html';
const JS = 'application/javascript';

export type Surface = {
  type: string;
  body: () => string;
  admin?: true;
  action?: string;
};

export const SURFACES: Record<string, Surface> = {
  [ROUTE_PREFIX]: { type: HTML, body: PANEL_SHELL, admin: true, action: 'manage shared albums' },
  [`${ROUTE_PREFIX}/`]: { type: HTML, body: PANEL_SHELL, admin: true, action: 'manage shared albums' },
  [`${ROUTE_PREFIX}/accept`]: { type: HTML, body: ACCEPT_SHELL },
  [`${ROUTE_PREFIX}/banner.js`]: { type: JS, body: () => BANNER_JS },
  [`${ROUTE_PREFIX}/panel.bundle.js`]: { type: JS, body: () => PANEL_BUNDLE },
  [`${ROUTE_PREFIX}/accept.bundle.js`]: { type: JS, body: () => ACCEPT_BUNDLE },
};

export const surfaceFor = (path: string): Surface | undefined => SURFACES[path];
