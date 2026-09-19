/** web/passthrough.ts — transparent streaming proxy to Immich for every non-sidecar route. See http-router.md. */
import { Readable } from 'node:stream';
import { CFG, log } from '../config.ts';

/** How much of a request body to hold in memory before falling back to streaming it through.
 *
 *  Immich answers some requests BEFORE reading the body — its auth guard rejects an unauthenticated
 *  request the moment it sees the route — and a body handed to `fetch` as a STREAM does not survive
 *  that: undici rejects with `fetch failed`, the rejection escapes the handler, and no response is
 *  ever written, so the caller waits until it gives up. Measured on the rig: `POST` → `401` hung
 *  forever while `POST` → `400` and `POST` → `404` returned in milliseconds, because those routes
 *  read the body first.
 *
 *  Every API call a browser makes through here (including all of them, the moment a session expires)
 *  is far below this, so they get a real answer; uploads keep streaming. */
const BUFFER_UP_TO_BYTES = 256 * 1024;

/** The body as a Buffer when it is small, or a stream when it is not. */
async function bodyFor(req): Promise<Buffer | Readable> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BUFFER_UP_TO_BYTES) {
      // Too big to hold. Replay what was read, then continue from the socket untouched.
      const rest = (async function* () {
        yield Buffer.concat(chunks);
        for await (const more of req) yield more;
      })();
      return Readable.from(rest);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function proxyToImmich(req, res): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(', ');
  }
  delete headers.host;
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  try {
    const body = hasBody ? await bodyFor(req) : undefined;
    const up = await fetch(`${CFG.immichUrl}${req.url}`, {
      method: req.method,
      headers,
      body,
      // required by undici whenever a stream is used as a request body
      ...(body instanceof Readable ? { duplex: 'half' } : {}),
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
  } catch (e) {
    // FAIL LOUDLY, never silently: a caller left waiting for a response is the one outcome worse
    // than an error, and it is what this proxy did before the buffering above.
    log(`proxying ${req.method} ${req.url} failed: ${(e as Error).message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `the addons could not reach Immich: ${(e as Error).message}` }));
  }
}
