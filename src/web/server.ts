/**
 * web/server.ts — the single HTTP entry point. Routes sidecar protocol endpoints, the
 * panel/accept pages, the hotlink byte interceptors, and a transparent fall-through proxy
 * to Immich (banner-injected on /share pages). Exports the server; index.ts starts it.
 *
 * Two rules hold everywhere below, because every route here may be published to the
 * internet:
 *  - Route BEFORE reading a body. Only the sidecar's own JSON routes are buffered, under
 *    a hard cap; passthrough traffic (which includes photo uploads) streams straight
 *    through. Buffering first would let any caller size our memory.
 *  - Human routes authenticate against the caller's own Immich session (web/auth.ts);
 *    peer routes authenticate by signature AND check entitlement (p2p/entitlement.ts).
 *    Being able to reach a route is never permission to use it.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { CFG, log } from '../config.ts';
import { state } from '../state.ts';
import { immich } from '../immich/client.ts';
import { verify } from '../peers.ts';
import { handlePreview, handleOriginal, handlePlayback } from '../media/proxy.ts';
import { serveInterceptedBytes } from '../media/interceptor.ts';
import { PANEL, ACCEPT_PAGE } from './pages.ts';
import { BANNER_JS } from './banner.ts';
import { proxyToImmich } from './passthrough.ts';
import { callerIdentity, signInRequired, SIGN_IN_PAGE } from './auth.ts';
import { handleRedeem, handleRefs, handleVersion, handleNudge, handleManifest } from '../p2p/protocol.ts';
import { join } from '../p2p/join.ts';
import { leaveAlbum } from '../sync/engine.ts';
import { handleActivity, handleComments } from '../sync/comments.ts';

/**
 * Read a JSON-route body under a hard cap, or null if it is too big.
 *
 * Oversize input is DRAINED rather than buffered: memory stays O(1), which is the point,
 * while the socket survives long enough for the caller to actually receive the 413.
 * Destroying the request instead resets the connection, and the client sees a network
 * error rather than an answer. Cutting the upload off at the wire is the reverse proxy's
 * job — see the `request_body` cap in deploy/Caddyfile.snippet.
 */
async function readCappedBody(req): Promise<string | null> {
  const max = CFG.maxBodyKb * 1024;
  if (Number(req.headers['content-length'] || 0) > max) { req.resume(); return null; }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) { req.resume(); return null; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

export const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://x');
    let m;
    // Peer-facing avatar read. Signed like every other peer route — a bare public key is
    // not a credential, it is published in every redeem response.
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/users\/([^/]+)\/avatar$/))) {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      const peerKey = req.headers['x-isa-key'] as string;
      const peer = state.peers.find(pp => pp.pub === peerKey);
      const related = peer && state.mappings.some(mp => mp.peer === peerKey && !mp.dead);
      if (!peer || !related || !verify(m[1], req.headers['x-isa-sig'] as string || '', peerKey)) {
        return send(403, { error: 'unknown or unverified peer' });
      }
      try {
        const av = await immich(`/users/${m[1]}/profile-image`);
        res.writeHead(200, { 'Content-Type': av.headers.get('content-type') || 'image/jpeg' });
        return res.end(Buffer.from(await av.arrayBuffer()));
      } catch { return send(404, { error: 'no avatar' }); }
    }
    if (u.pathname === '/sidecar/banner.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(BANNER_JS);
    }
    if (u.pathname === '/sidecar/accept') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(ACCEPT_PAGE());
    }
    // Byte interceptors (hotlink model): the app's own asset URLs are served with true
    // bytes streamed live from the owner's server for proxy assets. See media/interceptor.
    const assetHit = u.pathname.match(/^\/api\/assets\/([^/]+)\/(thumbnail|original|video\/playback)$/);
    if (assetHit && req.method === 'GET' && await serveInterceptedBytes(req, res, assetHit[1], assetHit[2])) return;
    // Everything that isn't a sidecar route -> transparent proxy to Immich (banner-injected
    // on /share pages). Streams both ways: uploads must not be buffered here.
    if (!u.pathname.startsWith('/sidecar')) return proxyToImmich(req, res, u.pathname);

    // ---- the sidecar's own routes: cap the body, then authorise ----
    const body = await readCappedBody(req);
    if (body === null) return send(413, { error: `request body exceeds ${CFG.maxBodyKb}KB` });

    if (u.pathname === '/sidecar/' || u.pathname === '/sidecar') {
      const caller = await callerIdentity(req);
      if (!caller?.isAdmin) {
        res.writeHead(caller ? 403 : 401, { 'Content-Type': 'text/html' });
        return res.end(SIGN_IN_PAGE('manage shared albums'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PANEL());
    }
    if (u.pathname === '/sidecar/join' && req.method === 'POST') {
      // The account being joined is the SIGNED-IN one. The request body may name a
      // different user only if the caller is an admin acting on their behalf.
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('join a shared album'));
      try {
        const b = JSON.parse(body);
        const forUserId = b.forUserId || caller.id;
        if (forUserId !== caller.id && !caller.isAdmin) {
          return send(403, { error: 'you can only join an album for your own account' });
        }
        return send(200, await join(b.url, forUserId, b.password));
      } catch (e) {
        return send(e.passwordRequired ? 401 : 400,
          e.passwordRequired ? { error: e.message, passwordRequired: true } : { error: e.message });
      }
    }
    if (u.pathname === '/sidecar/leave' && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('leave a shared album'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can remove a shared album' });
      try { const b = JSON.parse(body); return send(200, await leaveAlbum(b.mappingId)); }
      catch (e) { return send(400, { error: e.message }); }
    }
    if (u.pathname === '/sidecar/api/v1/invites/redeem' && req.method === 'POST') {
      const [code, obj] = await handleRedeem(req, body); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/activity$/)) && req.method === 'POST') {
      const [code, obj] = await handleActivity(req, body, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/refs$/)) && req.method === 'POST') {
      const [code, obj] = await handleRefs(req, body, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/version$/)) && req.method === 'GET') {
      const [code, obj] = await handleVersion(req, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/manifest$/)) && req.method === 'GET') {
      const [code, obj] = await handleManifest(req, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/comments$/)) && req.method === 'GET') {
      const [code, obj] = await handleComments(req, m[1]); return send(code, obj);
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/albums\/([^/]+)\/nudge$/)) && req.method === 'POST') {
      const [code, obj] = await handleNudge(req, body, m[1]); return send(code, obj);
    }
    const streamOut = (out) => { // stream byte responses through — never buffer (Pi-friendly)
      if (Array.isArray(out)) return send(out[0], out[1]);
      const headers: Record<string, string> = { 'Content-Type': out.headers.get('content-type') || 'application/octet-stream' };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const v = out.headers.get(h); if (v) headers[h] = v;
      }
      res.writeHead(out.status || 200, headers);
      Readable.fromWeb(out.body).pipe(res);
    };
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/original$/))) {
      return streamOut(await handleOriginal(req, m[1]));
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/playback$/))) {
      return streamOut(await handlePlayback(req, m[1]));
    }
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/assets\/([^/]+)\/preview$/))) {
      const out = await handlePreview(req, m[1]);
      if (Array.isArray(out)) return send(out[0], out[1]);
      res.writeHead(200, { 'Content-Type': out.headers.get('content-type') || 'image/jpeg' });
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
    // Liveness only. The join banner probes this cross-origin to discover a sidecar, so
    // it stays open — which is exactly why it must not name the household or count peers.
    if (u.pathname === '/sidecar/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    }
    send(404, { error: 'not found' });
  } catch (e) { log('http error:', e.message); send(500, { error: e.message }); }
});
