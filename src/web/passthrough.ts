/**
 * web/passthrough.ts — transparent fall-through proxy to Immich for anything that isn't a
 * sidecar route (share pages, SPA bundles, /api). Injects the join banner into /share HTML.
 * In production a reverse proxy may handle this directly, but the sidecar can also be the
 * SINGLE front for Immich — which is the simplest thing to install, because it needs one
 * reverse-proxy route instead of three path-matched ones in a required order. Protocol
 * upgrades are carried by web/upgrade.ts, so live web updates work in that mode too.
 *
 * Both directions stream. Photo uploads reach Immich through here in the single-front
 * setup, and buffering them would put every upload in the sidecar's heap — the opposite of
 * Pi-friendly, and a free memory-exhaustion lever for anyone who can reach the port. Only
 * /share HTML is buffered, because injecting the banner means rewriting the document.
 */
import { Readable } from 'node:stream';
import { CFG, ROUTE_PREFIX } from '../config.ts';
import { BANNER_JS } from './banner.ts';

export async function proxyToImmich(req, res, pathname: string): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(', ');
  }
  delete headers.host;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const up = await fetch(`${CFG.immichUrl}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    // required by undici whenever a stream is used as a request body
    ...(hasBody ? { duplex: 'half' } : {}),
    redirect: 'manual',
  } as RequestInit);
  const outHeaders = {};
  for (const [k, v] of up.headers)
    if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) outHeaders[k] = v;
  const setCookie = up.headers.getSetCookie?.() || [];
  if (setCookie.length) outHeaders['set-cookie'] = setCookie;
  const ct = up.headers.get('content-type') || '';
  if (req.method === 'GET' && pathname.startsWith('/share/') && ct.includes('text/html') && BANNER_JS) {
    let html = Buffer.from(await up.arrayBuffer()).toString();
    html = html.includes('</body>')
      ? html.replace('</body>', `<script src="${ROUTE_PREFIX}/banner.js" defer></script></body>`)
      : html + `<script src="${ROUTE_PREFIX}/banner.js" defer></script>`;
    res.writeHead(up.status, outHeaders);
    res.end(html);
    return;
  }
  res.writeHead(up.status, outHeaders);
  if (!up.body) {
    res.end();
    return;
  }
  Readable.fromWeb(up.body).pipe(res);
}
