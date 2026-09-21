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
import { state, store, storeSharedAssetsLocally } from '../state.ts';
import { immichJson, publicShareLinkMeta } from '../immich/client.ts';
import { serveInterceptedBytes } from '../media/interceptor.ts';
import { surfaceFor } from './frontend.ts';
import { myAlbums, myMatches, publishAlbumsForPeer } from './me.ts';
import { invitePeerToReunite } from '../sync/album-invite.ts';
import { unifyOwnAlbum } from '../p2p/mirror.ts';
import { readCallerAlbums, visibleAlbumIds } from '../immich/access.ts';
import { findAdoptableAlbum } from '../sync/adoption.ts';
import { parseRequestedPeer } from '../sync/matches.ts';
import { sharePage, signInPage } from './assets.ts';
import { localAddr } from '../p2p/transport.ts';
import { keys } from '../state.ts';
import { proxyToImmich } from './passthrough.ts';
import { callerIdentity, callerSignedIn, signInRequired } from './auth.ts';
import { join } from '../p2p/join.ts';
import { stripAlbumBots } from '../sync/album-grant.ts';
import { auditLine } from '../sync/audit.ts';
import { leaveAlbum } from '../sync/leave.ts';
import { syncStatus, loopTicks, nudgesReceived } from '../sync/status.ts';
import { emitPanelEvent, panelHintsEmitted } from '../panel-events.ts';
import { setSweepsPaused, sweepsAreIdle, sweepsArePaused, whenSweepsIdle } from '../sweeps.ts';
import { hideAsUnmeasured } from '../immich/unmeasured.ts';
import { panelSubscribers, subscribeToPanelEvents } from '../panel-events.ts';
import { forgetVisits, noteIndexTraffic, offerAlbumsFrom } from '../sync/index-freshness.ts';
import { trafficTriggerFor } from '../sync/traffic-triggers.ts';
import { syncComments } from '../sync/comments.ts';
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
      } else if (surface.signedIn) {
        // Any signed-in user; the page scopes to their own id. Fail closed — no session, no page.
        if (!(await callerIdentity(req))) {
          res.writeHead(401, { 'Content-Type': 'text/html' });
          return res.end(signInPage(surface.action ?? 'use this page'));
        }
      }
      res.writeHead(200, { 'Content-Type': surface.type, 'Cache-Control': 'no-cache' });
      return res.end(surface.body());
    }
    // The share shell: the native share page framed under the join card. ?native=1 is the
    // passthrough escape hatch (what the iframe loads, and where dismiss navigates).
    const shareHit = u.pathname.match(/^\/share\/([^/]+)$/);
    if (shareHit && u.searchParams.has('native')) {
      // Hand Immich the BARE path. Its share route matches the exact path, so any query string
      // answers 404 with the bare app shell: the album still boots client-side, which is why this
      // hides, but the SERVER-rendered share metadata is gone (og:title, the photo count) and the
      // address bar the dismiss link leaves behind is a 404 — so the link a recipient then copies
      // previews as nothing. Only OUR marker is removed; any other parameter is not ours to drop.
      const rest = new URLSearchParams(u.searchParams);
      rest.delete('native');
      const query = rest.toString();
      req.url = u.pathname + (query ? `?${query}` : '');
    }
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
    if (!path.startsWith(ROUTE_PREFIX)) {
      // THE FRONT DOOR IS WHERE A PERSON ARRIVES. This sidecar serves Immich itself, so a request
      // that changes an album, or a sign-in, is how we learn their albums need offering — see
      // `indexTriggerFor`: the byte path for every thumbnail on screen is deliberately NOT a trigger,
      // because that is the traffic this proxy exists to keep cheap. Fire-and-forget and wrapped:
      // nothing about a proxied request may depend on it, and it must never be able to fail one.
      const proxied = proxyToImmich(req, res);
      // AFTER the response, not before: an album mutation is only a change once Immich has made it,
      // and reading on the way in races the very write that prompted the read (measured: the album
      // created by that request was missing from the list we then published).
      void proxied
        .then(() => {
          try {
            const trigger = trafficTriggerFor(req.method || 'GET', u.pathname);
            // A comment written in the app is pushed NOW: the comment loop's cadence is a safety
            // net, not the latency a person should feel waiting for their own message to arrive.
            if (trigger === 'comment') void syncComments();
            else if (trigger) noteIndexTraffic(trigger, req.headers);
          } catch {
            /* fail-open: Immich traffic never waits on, or breaks from, our bookkeeping */
          }
        })
        .catch(() => {
          /* the proxy already answered; a failed request changes nothing to offer */
        });
      return proxied;
    }

    // ---- the sidecar's own routes: cap the body, then authorise ----
    const body = await readCappedBody(req);
    if (body === null) return send(413, { error: `request body exceeds ${CFG.maxBodyKb}KB` });

    // Would joining this link leave the caller with a SECOND album of a name they already own? The
    // accept page asks BEFORE it joins, because a plain join would create the duplicate this feature
    // exists to remove, and the person would have to reunite the two afterwards in the panel.
    //
    // It deliberately does NOT redeem the link to find out. Redeeming pins the caller as a peer on
    // the ORIGIN and writes an owner mapping there, so a preview that redeemed would enrol a
    // household on someone else's server merely because a page opened. The album's name is all this
    // needs, and it arrives from the share page the person just came from.
    if (path === `${ROUTE_PREFIX}/join/preview` && req.method === 'POST') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('check this album against your own'));
      let asked: { albumName?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (typeof asked.albumName !== 'string') return send(400, { error: 'name the album the link is for' });
      try {
        // The SAME function the join itself re-derives with, so a preview can never offer a marriage
        // the adoption would refuse — and the caller's own album list is read on THEIR credential,
        // because only Immich can say which albums are theirs.
        const reunion = findAdoptableAlbum(
          { albumName: asked.albumName, peerOwnerUserId: '' },
          await readCallerAlbums(signedIn.creds),
          signedIn.caller.id
        );
        return send(200, { albumName: asked.albumName, ...(reunion ? { reunion } : {}) });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    if (path === `${ROUTE_PREFIX}/join` && req.method === 'POST') {
      // The account being joined is the SIGNED-IN one. The request body may name a
      // different user only if the caller is an admin acting on their behalf.
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('join a shared album'));
      const caller = signedIn.caller;
      try {
        const b = JSON.parse(body);
        const forUserId = b.forUserId || caller.id;
        if (forUserId !== caller.id && !caller.isAdmin) {
          return send(403, { error: 'you can only join an album for your own account' });
        }
        const endpoint = JSON.parse(
          Buffer.from(String(b.invite?.endpointToken ?? ''), 'base64url').toString()
        );
        // A reunification may only adopt the caller's OWN album, and only on their own credential.
        // Both are re-checked in ensureMirror; naming an id here is a request, not a decision.
        const adopt =
          b.adopt && typeof b.adopt.albumId === 'string' && b.adopt.albumId && forUserId === caller.id
            ? { albumId: b.adopt.albumId, ownerCreds: signedIn.creds }
            : undefined;
        return send(200, await join({ endpoint, key: b.invite?.key }, forUserId, b.password, adopt));
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
      return send(200, {
        shareLinkJoin: shareLinkJoiningEnabled(),
        pairingTtlMinutes: pairingTtlMinutes(),
        storeSharedAssetsLocally: storeSharedAssetsLocally(),
      });
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
          storeSharedAssetsLocally: b.storeSharedAssetsLocally === true,
        });
        return send(200, {
          shareLinkJoin: shareLinkJoiningEnabled(),
          pairingTtlMinutes: pairingTtlMinutes(),
          storeSharedAssetsLocally: storeSharedAssetsLocally(),
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
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('link a server'));
      if (!signedIn.caller.isAdmin) return send(403, { error: 'only an admin can link a server' });
      try {
        const b = JSON.parse(body);
        const linked = await redeemPairing(b.link);
        emitPanelEvent('shares');
        // The person who just linked is the only person whose credential is in hand at this moment,
        // and a link whose albums are not offered yet is a link nothing can be matched against. Read
        // theirs now, and tell the peer to look — the rest of the household arrives as they use
        // Immich (see index-freshness.ts).
        void offerAlbumsFrom(signedIn.creds).catch(e =>
          log(`could not offer the linking person's albums: ${e.message}`)
        );
        return send(200, linked);
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
    // Per-user panel data: the caller's own shared albums, read AS the caller so Immich answers
    // membership (never a client-supplied id, never a filtered admin read).
    if (path === `${ROUTE_PREFIX}/me/albums` && req.method === 'GET') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('see your albums'));
      return send(200, {
        albums: await myAlbums(signedIn.creds),
        household: localHousehold().name,
        isAdmin: signedIn.caller.isAdmin,
      });
    }
    // The caller offers their OWN albums to one linked peer, so that peer can look for the other
    // half of a split album. The peer must be linked, only the CALLER can be recorded as owner,
    // and the body is filtered to albums Immich told the caller they own — see
    // publishAlbumsForPeer.
    if (path === `${ROUTE_PREFIX}/me/albums/publish` && req.method === 'POST') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('offer your albums for reunification'));
      const peerPub = parseRequestedPeer(body);
      if (!peerPub) return send(400, { error: 'name the linked server to offer albums to' });
      const peer = state.peers.find(p => p.pub === peerPub);
      if (!peer) return send(404, { error: 'no such linked server', code: 'unknown_peer' });
      const published = await publishAlbumsForPeer(signedIn.creds, signedIn.caller.id, peer.pub);
      log(`${signedIn.caller.name} offered ${published} owned album(s) to "${peer.name}" for matching`);
      return send(200, { published });
    }
    // Un-reunify: undo the ADOPTION, not the share. The album and its own photos stay, the peer's
    // stubs go, and the share returns to an ordinary mirror — so the origin is NOT told to stop
    // (`notifyOrigin: false`) and keeps offering the invitation, which the member's own invite poll
    // turns back into a mirror. Sending `/leave` here would retire the origin's mapping and lose the
    // share; and because the marker account stays on the album, a later poll would silently
    // re-create it, so the person's un-reunify would appear to undo itself.
    if (path === `${ROUTE_PREFIX}/me/unreunite` && req.method === 'POST') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('un-reunite an album'));
      let asked: { mappingId?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (typeof asked.mappingId !== 'string') return send(400, { error: 'name the share to un-reunite' });
      // ONLY AN ADOPTION, and only its album's owner. Membership is not authority here: on a mapping
      // that is not an adoption `leaveAlbum` DELETES the album, so an un-reunify that accepted one
      // would be a leave button wearing the wrong label. `canUnifyOwnAlbum` checks the other
      // direction (which album may be adopted) and cannot stand in for this.
      const mapping = state.mappings.find(m => m.id === asked.mappingId && !m.dead && m.adopted === true);
      if (!mapping) return send(404, { error: 'no such reunified share', code: 'unknown_mapping' });
      const visible = await visibleAlbumIds(signedIn.creds);
      if (!visible.has(mapping.albumId)) return send(403, { error: 'that share is not yours' });
      // Ownership is the fact that matters: the album is the person's own, and only they may give up
      // the reunion. Read as the caller, so the answer comes from Immich rather than from a claim.
      const reunionAlbum = await immichJson(
        `/albums/${mapping.albumId}?withoutAssets=true`,
        {},
        signedIn.creds
      ).catch(() => null);
      const callerOwnsIt = (reunionAlbum?.albumUsers || []).some(
        au => au.user?.id === signedIn.caller.id && au.role === 'owner'
      );
      if (!callerOwnsIt) return send(403, { error: "only the album's owner can un-reunite it" });
      try {
        const { albumId, albumName } = mapping;
        // Purge the peer's stubs FIRST, while our accounts still hold the memberships they were
        // granted, then take those accounts off — only the owner can, and the caller IS the owner
        // here. A leftover membership would keep our read access to a private album and make it
        // read as a live mirror to anything enumerating albums by stand-in key.
        const left = await leaveAlbum(mapping.id, { notifyOrigin: false });
        // The trail's withdrawal line, and it has to be written HERE: `leaveAlbum` has already purged
        // the peer's stubs, so the line describes the finished state, and `stripAlbumBots` is about to
        // take our accounts off the album — after which the bot could not comment on it at all. The
        // origin is deliberately not told (see above), so this album is the only one that gets it.
        await auditLine(
          mapping.id,
          albumId,
          'unreunited',
          `Un-reunited with "${state.peers.find(p => p.pub === mapping.peer)?.name ?? 'a linked server'}" — ` +
            `their photos are out of this album. It is still shared: reunite the two again any time from ` +
            `your shared-albums page.`
        );
        // Reported, never swallowed: the owner's credential is gone the moment this request ends, so
        // an account we failed to remove keeps reading a private album and NOTHING can retry it. The
        // caller is told, and `stripFailed` names what is still on the album.
        emitPanelEvent('shares');
        const { removed, failed } = await stripAlbumBots(albumId, signedIn.creds).catch(e => {
          log(`un-reunify could not take our accounts off "${albumName}": ${e.message}`);
          return { removed: 0, failed: ['unknown'] };
        });
        if (failed.length)
          log(
            `un-reunify left ${failed.length} of our account(s) on "${albumName}" — they still read it; remove them in Immich`
          );
        return send(200, { ...left, stripped: removed, ...(failed.length ? { stripFailed: failed } : {}) });
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    // Reunite: replace one of the caller's shares with an album they already own. The album id
    // names a request, not a decision — the operation re-derives that it is theirs and that it is
    // the album this share is about, on their own credential.
    if (path === `${ROUTE_PREFIX}/me/reunite` && req.method === 'POST') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('reunite an album'));
      let asked: { mappingId?: unknown; albumName?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (typeof asked.mappingId !== 'string' || typeof asked.albumName !== 'string')
        return send(400, { error: 'name the share and the album to reunite it with' });
      // Only shares this caller is in: the mapping is looked up, then the album it points at is
      // read as the caller, so a mapping they cannot see is one they cannot name.
      const mapping = state.mappings.find(m => m.id === asked.mappingId && !m.dead);
      if (!mapping) return send(404, { error: 'no such share', code: 'unknown_mapping' });
      const visible = await visibleAlbumIds(signedIn.creds);
      if (!visible.has(mapping.albumId)) return send(403, { error: 'that share is not yours' });
      try {
        // The panel names the ALBUM by name; which local album that is gets resolved from the
        // caller's own list inside the operation, so no id crosses the wire or is taken on trust.
        const outcome = await unifyOwnAlbum(
          mapping,
          { albumName: asked.albumName },
          signedIn.creds,
          signedIn.caller.id
        );
        return send(200, outcome);
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    // Albums the caller could reunite. Read-only and computed on demand: the action on each row is
    // decided by the share behind it (`reunionStepFor`), so what the panel renders and what it may
    // call come from the same answer.
    if (path === `${ROUTE_PREFIX}/me/matches` && req.method === 'GET') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('see possible reunions'));
      return send(200, { matches: await myMatches(signedIn.creds, signedIn.caller.id) });
    }
    // Invite: share one of the caller's OWN albums with the person on a linked server who owns the
    // other half, which is how a reunion starts. The same membership Immich's picker creates, on the
    // caller's own album and their own credential — the row used to send them to Immich to do it.
    if (path === `${ROUTE_PREFIX}/me/invite` && req.method === 'POST') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('invite someone to reunite an album'));
      let asked: { peer?: unknown; albumName?: unknown; ownerUserId?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (
        typeof asked.peer !== 'string' ||
        typeof asked.albumName !== 'string' ||
        typeof asked.ownerUserId !== 'string'
      )
        return send(400, { error: 'name the linked server, the album, and whose half it is' });
      const peer = state.peers.find(p => p.pub === asked.peer);
      if (!peer) return send(404, { error: 'no such linked server', code: 'unknown_peer' });
      try {
        // Both the album and the person are re-derived inside: the album from the caller's own
        // Immich list, the person from the index the peer itself published. The body names them; it
        // does not establish either.
        const invited = await invitePeerToReunite(signedIn.creds, signedIn.caller.id, peer, {
          albumName: asked.albumName,
          ownerUserId: asked.ownerUserId,
        });
        log(`${signedIn.caller.name} invited "${invited.invited}" to reunite "${invited.album}"`);
        return send(200, invited);
      } catch (e) {
        return send(400, { error: e.message });
      }
    }
    // The panels' live channel: one open response per open panel, carrying hints only. Signed in,
    // like every panel route — the caller's own data is what they will re-read, so the gate is the
    // same one the panel itself passes.
    if (path === `${ROUTE_PREFIX}/events` && req.method === 'GET') {
      const signedIn = await callerSignedIn(req);
      if (!signedIn) return send(401, signInRequired('follow your albums'));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Proxies that buffer would hold every hint until the connection closed, which is the bug
        // this header exists to prevent (Caddy and nginx both honour it).
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const unsubscribe = subscribeToPanelEvents(type => {
        try {
          res.write(`data: ${JSON.stringify({ type })}\n\n`);
        } catch {
          /* the panel went away between the event and this write; its close handler unsubscribes */
        }
      });
      // A heartbeat, so an idle intermediary does not close a quiet panel.
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
      log(`panel following events (${panelSubscribers()} open)`);
      // THE RESPONSE'S close, not the request's: a bodyless GET completes immediately, so `req`'s
      // close fires while the response is still open — cleaning up there would unsubscribe a panel
      // that is still watching. One idempotent cleanup, whichever of these arrives first.
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
        log(`panel stopped following events (${panelSubscribers()} open)`);
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }
    // Rig-only progress read for the e2e suite: the same derivation `/albums/:id/status` answers
    // over iroh (`sync/status.ts`), plus the loop tick counts, so a test can wait for "the sidecar
    // has looked N more times" without speaking the peer protocol. Gated like every hook must be:
    // absent unless ISA_TEST_HOOKS is set, admin-only, and it names nothing the caller did not
    // already identify by album id.
    if (CFG.testHooks && path === `${ROUTE_PREFIX}/sync/status` && req.method === 'GET') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('read sync status'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can read sync status' });
      const albumId = u.searchParams.get('albumId');
      // No album asked for: the counters alone, which is what a test needs to tell a nudge from a
      // sweep before any mapping exists (a pairing creates none).
      if (!albumId)
        return send(200, { ticks: loopTicks(), nudges: nudgesReceived(), hints: panelHintsEmitted() });
      const mapping = state.mappings.find(m => m.albumId === albumId);
      if (!mapping) return send(404, { error: 'no mapping for that album' });
      // `ticks` and `nudges` together are how a test tells WHICH mechanism delivered a change: a
      // state that moved with no tick in between was the nudge, and a nudge counter that did not
      // move cannot have been. See index-offer.test.ts for the timing rules themselves.
      return send(200, {
        ...syncStatus(mapping),
        ticks: loopTicks(),
        nudges: nudgesReceived(),
        hints: panelHintsEmitted(),
      });
    }
    // Rig-only: emit a panel event on demand. A test that had to wait for a peer to nudge would be
    // testing the peer path as well as the channel; this asks the channel alone, so a browser test
    // (or the lane) can prove an open page reacts to a hint without a reload.
    if (CFG.testHooks && path === `${ROUTE_PREFIX}/test/emit` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('emit an event'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can emit an event' });
      let asked: { type?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (asked.type !== 'invitations' && asked.type !== 'index' && asked.type !== 'shares')
        return send(400, { error: 'type must be invitations, index or shares' });
      emitPanelEvent(asked.type);
      return send(200, { ok: true, panels: panelSubscribers() });
    }
    // Rig-only: pretend Immich has not measured a photo's dimensions yet, so a lane can stand in
    // the window between an upload and its metadata job — the photo is held back rather than
    // mirrored as a square stub, and arrives shaped once the truth is visible again. The mask is
    // read where refs are built/appraised (`immich/refs.ts`), so it affects this server's view only.
    if (CFG.testHooks && path === `${ROUTE_PREFIX}/test/hide-dimensions` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('hide dimensions'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can hide dimensions' });
      let asked: { assetId?: unknown; hidden?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (typeof asked.assetId !== 'string' || typeof asked.hidden !== 'boolean')
        return send(400, { error: 'name the asset and whether to hide its dimensions' });
      hideAsUnmeasured(asked.assetId, asked.hidden);
      log(`rig: dimensions for ${asked.assetId.slice(0, 8)} ${asked.hidden ? 'hidden' : 'visible again'}`);
      return send(200, { assetId: asked.assetId, hidden: asked.hidden });
    }
    // Rig-only: hold the background loops still, or release them. A lane that holds them and still
    // sees a change arrive has proved the nudge delivered it, which no cadence can be argued into:
    // the loops are the only thing that could otherwise have carried it. See sync-loops.md.
    if (CFG.testHooks && path === `${ROUTE_PREFIX}/test/pause-sweeps` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('hold the sweeps'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can hold the sweeps' });
      let asked: { paused?: unknown };
      try {
        asked = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'malformed request body' });
      }
      if (typeof asked.paused !== 'boolean') return send(400, { error: 'paused must be true or false' });
      setSweepsPaused(asked.paused);
      // A hold stops the NEXT tick, not the one already running: acknowledged before that cycle
      // finished, it would let a lane claim "no sweep delivered this" while one still could. Bounded,
      // so a slow cycle answers `idle: false` rather than hanging the request.
      const idle = asked.paused ? await whenSweepsIdle() : sweepsAreIdle();
      log(
        `rig: background sweeps ${asked.paused ? 'held' : 'released'}${idle ? '' : ' (a cycle is still running)'}`
      );
      return send(200, { paused: sweepsArePaused(), idle });
    }
    // Rig-only: forget every session, so the next authenticated request is treated as the first of
    // one. The real quiet period is fifteen minutes, which no test can wait out (index-offer.ts).
    if (CFG.testHooks && path === `${ROUTE_PREFIX}/test/new-session` && req.method === 'POST') {
      const caller = await callerIdentity(req);
      if (!caller) return send(401, signInRequired('forget sessions'));
      if (!caller.isAdmin) return send(403, { error: 'only an admin can forget sessions' });
      forgetVisits();
      return send(200, { ok: true });
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
