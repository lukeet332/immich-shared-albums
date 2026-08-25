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
 *    peer traffic rides iroh (identity = the connection) and checks entitlement (p2p/entitlement.ts).
 *    Being able to reach a route is never permission to use it.
 */
import http from 'node:http';
import { CFG, log, ROUTE_PREFIX } from '../config.ts';
import { store } from '../state.ts';
import { publicShareLinkMeta } from '../immich/client.ts';
import { serveInterceptedBytes } from '../media/interceptor.ts';
import { surfaceFor } from './frontend.ts';
import { sharePage, signInPage } from './assets.ts';
import { localAddr } from '../p2p/transport.ts';
import { keys } from '../state.ts';
import { proxyToImmich } from './passthrough.ts';
import { callerIdentity, signInRequired } from './auth.ts';
import { join } from '../p2p/join.ts';
import { leaveAlbum } from '../sync/leave.ts';
import { unlinkPeer, linkedPeers, localHousehold, sharedAlbums } from '../p2p/unlink.ts';
import {
  mintPairing,
  pendingPairings,
  revokePairing,
  redeemPairing,
  parseTicket,
  pairingTtlMinutes,
  TTL_MINUTES,
} from '../p2p/pair.ts';
import { PROTOCOL_VERSION } from '../types.ts';

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
  if (Number(req.headers['content-length'] || 0) > max) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) {
      req.resume();
      return null;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString();
}

// Default ON. Off refuses redemption itself, not just the join card — the label promises it.
const shareLinkJoiningEnabled = () =>
  (store.kv('settings') as { shareLinkJoin?: boolean } | null)?.shareLinkJoin !== false;

export const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    const path = u.pathname;
    // Human-facing surfaces — pages and scripts — come from ONE table, so "what exists and who
    // may see it" is answerable by reading web/frontend.ts rather than tracing this file. Served
    // before the body cap because none of them has a body to read.
    const surface = surfaceFor(path);
    if (surface) {
      if (surface.admin) {
        const caller = await callerIdentity(req);
        if (!caller?.isAdmin) {
          res.writeHead(caller ? 403 : 401, { 'Content-Type': 'text/html' });
          return res.end(signInPage(surface.action ?? 'use this page'));
        }
      }
      res.writeHead(200, { 'Content-Type': surface.type, 'Cache-Control': 'no-cache' });
      return res.end(surface.body());
    }
    // The share shell: the native share page framed under the join card. ?native=1 is the
    // passthrough escape hatch (what the iframe loads, and where dismiss navigates).
    const shareHit = u.pathname.match(/^\/share\/([^/]+)$/);
    if (shareHit && req.method === 'GET' && shareLinkJoiningEnabled() && !u.searchParams.has('native')) {
      const meta = await publicShareLinkMeta(shareHit[1]);
      const addr = localAddr();
      const endpointToken = Buffer.from(
        JSON.stringify({ pub: keys.pub, relay: addr.relayUrl() ?? undefined, addrs: addr.directAddresses() })
      ).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      return res.end(
        sharePage(
          endpointToken,
          meta && {
            albumName: meta.albumName,
            coverUrl: meta.coverAssetId
              ? `/api/assets/${meta.coverAssetId}/thumbnail?key=${encodeURIComponent(shareHit[1])}`
              : undefined,
          }
        )
      );
    }
    // Byte interceptors (hotlink model): the app's own asset URLs are served with true
    // bytes streamed live from the owner's server for proxy assets. See media/interceptor.
    const assetHit = u.pathname.match(/^\/api\/assets\/([^/]+)\/(thumbnail|original|video\/playback)$/);
    if (assetHit && req.method === 'GET' && (await serveInterceptedBytes(req, res, assetHit[1], assetHit[2])))
      return;
    // Everything that isn't a sidecar route -> transparent proxy to Immich.
    // Streams both ways: uploads must not be buffered here.
    if (!path.startsWith(ROUTE_PREFIX)) return proxyToImmich(req, res);

    // ---- the sidecar's own routes: cap the body, then authorise ----
    const body = await readCappedBody(req);
    if (body === null) return send(413, { error: `request body exceeds ${CFG.maxBodyKb}KB` });

    if (path === `${ROUTE_PREFIX}/join` && req.method === 'POST') {
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
        const endpoint = JSON.parse(
          Buffer.from(String(b.invite?.endpointToken ?? ''), 'base64url').toString()
        );
        return send(200, await join({ endpoint, key: b.invite?.key }, forUserId, b.password));
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
        const b = JSON.parse(body);
        return send(200, await leaveAlbum(b.mappingId));
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    // Server links are admin-owned, so managing them is an admin route — not something expressed
    // by removing a bot from an album. See p2p/unlink.ts.
    if (path === `${ROUTE_PREFIX}/peers` && req.method === 'GET') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('see connected servers'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can see connected servers' });
      return send(200, { household: localHousehold(), peers: linkedPeers(), albums: sharedAlbums() });
    }
    if (path === `${ROUTE_PREFIX}/settings` && req.method === 'GET') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('change settings'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can change settings' });
      return send(200, { shareLinkJoin: shareLinkJoiningEnabled(), pairingTtlMinutes: pairingTtlMinutes() });
    }
    if (path === `${ROUTE_PREFIX}/settings` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('change settings'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can change settings' });
      try {
        const b = JSON.parse(body);
        const ttl = Number(b.pairingTtlMinutes ?? pairingTtlMinutes());
        if (!Number.isInteger(ttl) || ttl < TTL_MINUTES.min || ttl > TTL_MINUTES.max)
          return send(400, {
            error: `pairing links must be valid for ${TTL_MINUTES.min} minutes to ${TTL_MINUTES.max / 60} hours`,
          });
        store.kvSet('settings', {
          ...(store.kv('settings') ?? {}),
          shareLinkJoin: b.shareLinkJoin !== false,
          pairingTtlMinutes: ttl,
        });
        return send(200, {
          shareLinkJoin: shareLinkJoiningEnabled(),
          pairingTtlMinutes: pairingTtlMinutes(),
        });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/pairings` && req.method === 'GET') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('link a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can link a server' });
      return send(200, { pairings: pendingPairings() });
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
        const b = JSON.parse(body);
        // Accept a pending entry's id, or a pasted-back ticket for good measure.
        const raw = String(b.id || b.link || b.code || '');
        const ticket = parseTicket(raw);
        revokePairing(ticket ? ticket.secret : raw);
        return send(200, { revoked: true });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    // Pasting a link another server gave us. This is the standalone way to link two servers:
    // no album is involved, and pairing conveys no access to any photo.
    if (path === `${ROUTE_PREFIX}/pair` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('link a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can link a server' });
      try {
        const b = JSON.parse(body);
        return send(200, await redeemPairing(b.link));
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/unlink` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('unlink a server'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can unlink a server' });
      try {
        const b = JSON.parse(body);
        return send(200, await unlinkPeer(b.pub));
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    // Liveness only. The join banner probes this cross-origin to discover a sidecar, so
    // it stays open — which is exactly why it must not name the household or count peers.
    if (path === `${ROUTE_PREFIX}/health`) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
    }
    send(404, { error: 'not found' });
  } catch (e) {
    log('http error:', e.message);
    send(500, { error: e.message });
  }
});
