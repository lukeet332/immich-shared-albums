/** web/passthrough.ts — transparent proxy to Immich. Never buffer: uploads stream. See http-router.md. */
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
  const upstream = await fetch(`${CFG.immichUrl}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    ...(hasBody ? { duplex: 'half' } : {}),
    redirect: 'manual',
  } as RequestInit);
  const outHeaders = {};
  for (const [k, v] of upstream.headers)
    if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) outHeaders[k] = v;
  const setCookie = upstream.headers.getSetCookie?.() || [];
  if (setCookie.length) outHeaders['set-cookie'] = setCookie;
  const contentType = upstream.headers.get('content-type') || '';
  if (
    req.method === 'GET' &&
    pathname.startsWith('/share/') &&
    contentType.includes('text/html') &&
    BANNER_JS
  ) {
    let html = Buffer.from(await upstream.arrayBuffer()).toString();
    html = html.includes('</body>')
      ? html.replace('</body>', `<script src="${ROUTE_PREFIX}/banner.js" defer></script></body>`)
      : html + `<script src="${ROUTE_PREFIX}/banner.js" defer></script>`;
    res.writeHead(upstream.status, outHeaders);
    res.end(html);
    return;
  }
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}
