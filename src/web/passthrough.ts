/**
 * web/passthrough.ts — transparent fall-through proxy to Immich for anything that isn't a
 * sidecar route (share pages, SPA bundles, /api). Injects the join banner into /share HTML.
 * In production a reverse proxy usually handles this directly; this keeps the demo/simple
 * single-front setup fully working. Websocket upgrades are refused cleanly — a fetch()-based
 * proxy can't carry them; live web updates need the Immich port (or a real reverse proxy).
 */
import { CFG } from '../config.ts';
import { BANNER_JS } from './banner.ts';

export async function proxyToImmich(req, res, chunks, pathname: string): Promise<void> {
  if (req.headers.upgrade) { res.writeHead(426, { 'Content-Type': 'text/plain' }); res.end('websockets are not proxied here — connect to Immich directly'); return; }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v; else if (Array.isArray(v)) headers[k] = v.join(', ');
  }
  delete headers.host; delete headers['content-length'];
  const up = await fetch(`${CFG.immichUrl}${req.url}`, {
    method: req.method, headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    redirect: 'manual',
  });
  const outHeaders = {};
  for (const [k, v] of up.headers) if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) outHeaders[k] = v;
  const setCookie = up.headers.getSetCookie?.() || [];
  if (setCookie.length) outHeaders['set-cookie'] = setCookie;
  const ct = up.headers.get('content-type') || '';
  const buf = Buffer.from(await up.arrayBuffer());
  if (req.method === 'GET' && pathname.startsWith('/share/') && ct.includes('text/html') && BANNER_JS) {
    let html = buf.toString();
    html = html.includes('</body>') ? html.replace('</body>', '<script src="/sidecar/banner.js" defer></script></body>')
                                    : html + '<script src="/sidecar/banner.js" defer></script>';
    res.writeHead(up.status, outHeaders); res.end(html); return;
  }
  res.writeHead(up.status, outHeaders); res.end(buf);
}
