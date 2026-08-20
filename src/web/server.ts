/** web/server.ts — the single HTTP entry point. See http-router.md. */
import http from 'node:http';
import { Readable } from 'node:stream';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';
import { state } from '../state.ts';
import { immich } from '../immich/client.ts';
import { verify, callingPeer } from '../peers.ts';
import { handlePreview, handleOriginal, handlePlayback } from '../media/proxy.ts';
import { serveInterceptedBytes } from '../media/interceptor.ts';
import { surfaceFor } from './frontend.ts';
import { proxyToImmich } from './passthrough.ts';
import { callerIdentity, signInRequired, SIGN_IN_PAGE } from './auth.ts';
import { handleRedeem, handleRefs, handleVersion, handleNudge, handleManifest } from '../p2p/protocol.ts';
import { join } from '../p2p/join.ts';
import { leaveAlbum } from '../sync/leave.ts';
import { unlinkPeer, linkedPeers, localHousehold, sharedAlbums } from '../p2p/unlink.ts';
import { handlePair, mintPairing, pendingPairings, revokePairing, redeemPairing } from '../p2p/pair.ts';
import { handleActivity, handleComments } from '../sync/comments.ts';
import { invitationsFor, localDirectory } from '../sync/invites.ts';

/** Oversize input is DRAINED, NEVER buffered — see http-router.md. */
async function readCappedBody(req): Promise<string | null> {
  const max = CFG.maxBodyKb * 1024;
  if (Number(req.headers['content-length'] || 0) > max) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

export const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    let routeMatch;
    if ((routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/users\/([^/]+)\/avatar$/))) {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      const peerKey = req.headers['x-isa-key'] as string;
      const peer = state.peers.find(pp => pp.pub === peerKey);
      const related = peer && state.mappings.some(mp => mp.peer === peerKey && !mp.dead);
      if (!peer || !related || !verify(routeMatch[1], (req.headers['x-isa-sig'] as string) || '', peerKey)) {
        return send(403, { error: 'unknown or unverified peer' });
      }
      try {
        const avatar = await immich(`/users/${routeMatch[1]}/profile-image`);
        res.writeHead(200, { 'Content-Type': avatar.headers.get('content-type') || 'image/jpeg' });
        return res.end(Buffer.from(await avatar.arrayBuffer()));
      } catch {
        return send(404, { error: 'no avatar' });
      }
    }
    const surface = surfaceFor(path);
    if (surface) {
      if (surface.admin) {
        const caller = await callerIdentity(req);
        if (!caller?.isAdmin) {
          res.writeHead(caller ? 403 : 401, { 'Content-Type': 'text/html' });
          return res.end(SIGN_IN_PAGE(surface.action ?? 'use this page'));
        }
      }
      res.writeHead(200, { 'Content-Type': surface.type, 'Cache-Control': 'no-cache' });
      return res.end(surface.body());
    }
    // Must precede the passthrough, or Immich answers these itself.
    const assetHit = url.pathname.match(/^\/api\/assets\/([^/]+)\/(thumbnail|original|video\/playback)$/);
    if (assetHit && req.method === 'GET' && (await serveInterceptedBytes(req, res, assetHit[1], assetHit[2])))
      return;
    if (!path.startsWith(ROUTE_PREFIX)) return proxyToImmich(req, res, url.pathname);

    const body = await readCappedBody(req);
    if (body === null) return send(413, { error: `request body exceeds ${CFG.maxBodyKb}KB` });

    if (path === `${ROUTE_PREFIX}/join` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('join a shared album'));
      try {
        const request = JSON.parse(body);
        const forUserId = request.forUserId || caller.id;
        if (forUserId !== caller.id && !caller.isAdmin) {
          return send(403, { error: 'you can only join an album for your own account' });
        }
        return send(200, await join(request.url, forUserId, request.password));
      } catch (e) {
        return send(
          e.passwordRequired ? 401 : 400,
          e.passwordRequired ? { error: e.message, passwordRequired: true } : { error: e.message }
        );
      }
    }
    if (path === `${ROUTE_PREFIX}/leave` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('leave a shared album'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can remove a shared album' });
      try {
        const request = JSON.parse(body);
        return send(200, await leaveAlbum(request.mappingId));
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/peers` && req.method === 'GET') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('see connected servers'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can see connected servers' });
      return send(200, { household: localHousehold(), peers: linkedPeers(), albums: sharedAlbums() });
    }
    if (path === `${ROUTE_PREFIX}/pairings` && req.method === 'GET') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('link a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can link a server' });
      return send(200, { pairings: pendingPairings(), publicUrl: CFG.publicUrl });
    }
    if (path === `${ROUTE_PREFIX}/pairings` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('link a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can link a server' });
      try {
        return send(200, mintPairing());
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/pairings/revoke` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('revoke a pairing link'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can revoke a pairing link' });
      try {
        const request = JSON.parse(body);
        const code =
          String(request.link || request.code || '')
            .split('#')
            .pop() ?? '';
        revokePairing(code);
        return send(200, { revoked: true });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/pair` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('link a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can link a server' });
      try {
        const request = JSON.parse(body);
        return send(200, await redeemPairing(request.link));
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/unlink` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('unlink a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can unlink a server' });
      try {
        const request = JSON.parse(body);
        return send(200, await unlinkPeer(request.pub));
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/api/v1/pair` && req.method === 'POST') {
      const [code, obj] = await handlePair(req, body);
      return send(code, obj);
    }
    if (path === `${ROUTE_PREFIX}/api/v1/invites/redeem` && req.method === 'POST') {
      const [code, obj] = await handleRedeem(req, body);
      return send(code, obj);
    }
    if (
      (routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/albums\/([^/]+)\/activity$/)) &&
      req.method === 'POST'
    ) {
      const [code, obj] = await handleActivity(req, body, routeMatch[1]);
      return send(code, obj);
    }
    if (
      (routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/albums\/([^/]+)\/refs$/)) &&
      req.method === 'POST'
    ) {
      const [code, obj] = await handleRefs(req, body, routeMatch[1]);
      return send(code, obj);
    }
    if (
      (routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/albums\/([^/]+)\/version$/)) &&
      req.method === 'GET'
    ) {
      const [code, obj] = await handleVersion(req, routeMatch[1]);
      return send(code, obj);
    }
    if (
      (routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/albums\/([^/]+)\/manifest$/)) &&
      req.method === 'GET'
    ) {
      const [code, obj] = await handleManifest(req, routeMatch[1]);
      return send(code, obj);
    }
    if (
      (routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/albums\/([^/]+)\/comments$/)) &&
      req.method === 'GET'
    ) {
      const [code, obj] = await handleComments(req, routeMatch[1]);
      return send(code, obj);
    }
    if (path === `${ROUTE_PREFIX}/api/v1/directory` && req.method === 'GET') {
      const peer = callingPeer(req, 'directory');
      if (!peer) return send(403, { error: 'unknown or unverified peer' });
      return send(200, { users: await localDirectory() });
    }
    if (path === `${ROUTE_PREFIX}/api/v1/invitations` && req.method === 'GET') {
      const peer = callingPeer(req, 'invitations');
      if (!peer) return send(403, { error: 'unknown or unverified peer' });
      return send(200, { invitations: invitationsFor(peer.pub) });
    }
    if (
      (routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/albums\/([^/]+)\/nudge$/)) &&
      req.method === 'POST'
    ) {
      const [code, obj] = await handleNudge(req, body, routeMatch[1]);
      return send(code, obj);
    }
    const streamOut = out => {
      if (Array.isArray(out)) return send(out[0], out[1]);
      const headers: Record<string, string> = {
        'Content-Type': out.headers.get('content-type') || 'application/octet-stream',
      };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) {
        const value = out.headers.get(h);
        if (value) headers[h] = value;
      }
      res.writeHead(out.status || 200, headers);
      Readable.fromWeb(out.body).pipe(res);
    };
    if ((routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/assets\/([^/]+)\/original$/))) {
      return streamOut(await handleOriginal(req, routeMatch[1]));
    }
    if ((routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/assets\/([^/]+)\/playback$/))) {
      return streamOut(await handlePlayback(req, routeMatch[1]));
    }
    if ((routeMatch = path.match(/^\/immich-shared-albums\/api\/v1\/assets\/([^/]+)\/preview$/))) {
      const preview = await handlePreview(req, routeMatch[1]);
      if (Array.isArray(preview)) return send(preview[0], preview[1]);
      res.writeHead(200, { 'Content-Type': preview.headers.get('content-type') || 'image/jpeg' });
      return res.end(Buffer.from(await preview.arrayBuffer()));
    }
    if (path === `${ROUTE_PREFIX}/health`) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true }));
    }
    send(404, { error: 'not found' });
  } catch (e) {
    log('http error:', e.message);
    send(500, { error: e.message });
  }
});
