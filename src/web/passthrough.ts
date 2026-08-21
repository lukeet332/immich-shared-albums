/** web/passthrough.ts — transparent streaming proxy to Immich for every non-sidecar route. See http-router.md. */
import { Readable } from 'node:stream';
import { CFG } from '../config.ts';

export async function proxyToImmich(req, res): Promise<void> {
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
  res.writeHead(up.status, outHeaders);
  if (!up.body) {
    res.end();
    return;
  }
  Readable.fromWeb(up.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}
