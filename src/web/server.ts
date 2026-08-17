/**
 * web/server.ts — the single HTTP entry point. Routes sidecar protocol endpoints, the
 * panel/accept pages, the hotlink byte interceptors, and a transparent fall-through proxy
 * to Immich (banner-injected on /share pages). Exports the server; index.ts starts it.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { CFG, log } from '../config.ts';
import { state } from '../state.ts';
import { immich } from '../immich/client.ts';
import { handlePreview, handleOriginal, handlePlayback } from '../media/proxy.ts';
import { serveInterceptedBytes } from '../media/interceptor.ts';
import { PANEL, ACCEPT_PAGE } from './pages.ts';
import { BANNER_JS } from './banner.ts';
import { proxyToImmich } from './passthrough.ts';
import { handleRedeem, handleRefs, handleVersion, handleNudge, handleManifest } from '../p2p/protocol.ts';
import { join } from '../p2p/join.ts';
import { leaveAlbum } from '../sync/engine.ts';
import { handleActivity, handleComments } from '../sync/comments.ts';

export const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://x');
    let m;
    if ((m = u.pathname.match(/^\/sidecar\/api\/v1\/users\/([^/]+)\/avatar$/))) {
      const peerKey = req.headers['x-isa-key'];
      if (!state.peers.some(pp => pp.pub === peerKey)) return send(403, { error: 'unknown peer' });
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
    // on /share pages). See web/passthrough.
    if (!u.pathname.startsWith('/sidecar')) return proxyToImmich(req, res, chunks, u.pathname);
    if (u.pathname === '/sidecar/' || u.pathname === '/sidecar') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PANEL());
    }
    if (u.pathname === '/sidecar/join' && req.method === 'POST') {
      try { const b = JSON.parse(body); return send(200, await join(b.url, b.forUserId)); }
      catch (e) { return send(400, { error: e.message }); }
    }
    if (u.pathname === '/sidecar/leave' && req.method === 'POST') {
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
    if (u.pathname === '/sidecar/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, household: CFG.name, peers: state.peers.length }));
    }
    send(404, { error: 'not found' });
  } catch (e) { log('http error:', e.message); send(500, { error: e.message }); }
});
