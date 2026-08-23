/** p2p/routes.ts — the peer route table, served from the iroh accept loop. See wire-protocol.md. */
import { store, state } from '../state.ts';
import { immich } from '../immich/client.ts';
import { peerByPub } from '../peers.ts';
import type { PeerHandler } from './transport.ts';
import { handleRedeem, handleRefs, handleVersion, handleNudge, handleManifest } from './protocol.ts';
import { handlePair } from './pair.ts';
import { handleActivity, handleComments } from '../sync/comments.ts';
import { invitationsFor, localDirectory } from '../sync/invites.ts';
import { servePeerBytes } from '../media/proxy.ts';

const shareLinkJoiningEnabled = () =>
  (store.kv('settings') as { shareLinkJoin?: boolean } | null)?.shareLinkJoin !== false;

const json = ([status, obj]: any[]) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(obj)),
});

/** Every peer-callable operation. The transport already proved WHO callerPub is. */
export const peerRoutes: PeerHandler = async (callerPub, path, bodyBuf, range) => {
  const body = bodyBuf.toString();
  let m;
  if (path === '/pair') return json(await handlePair(callerPub, body));
  if (path === '/invites/redeem') {
    if (!shareLinkJoiningEnabled())
      return json([403, { error: 'this server does not accept album joins via shared links' }]);
    return json(await handleRedeem(callerPub, body));
  }
  if ((m = path.match(/^\/albums\/([^/]+)\/refs$/))) return json(await handleRefs(callerPub, body, m[1]));
  if ((m = path.match(/^\/albums\/([^/]+)\/activity$/)))
    return json(await handleActivity(callerPub, body, m[1]));
  if ((m = path.match(/^\/albums\/([^/]+)\/version$/))) return json(await handleVersion(callerPub, m[1]));
  if ((m = path.match(/^\/albums\/([^/]+)\/manifest$/))) return json(await handleManifest(callerPub, m[1]));
  if ((m = path.match(/^\/albums\/([^/]+)\/comments$/))) return json(await handleComments(callerPub, m[1]));
  if ((m = path.match(/^\/albums\/([^/]+)\/nudge$/))) return json(await handleNudge(callerPub, m[1]));
  if (path === '/directory') {
    if (!peerByPub(callerPub)) return json([403, { error: 'unknown peer' }]);
    return json([200, { users: await localDirectory() }]);
  }
  if (path === '/invitations') {
    if (!peerByPub(callerPub)) return json([403, { error: 'unknown peer' }]);
    return json([200, { invitations: invitationsFor(callerPub) }]);
  }
  if ((m = path.match(/^\/users\/([^/]+)\/avatar$/))) {
    // enrolled AND actually related — an avatar is personal data, not a public asset
    const related = peerByPub(callerPub) && state.mappings.some(mp => mp.peer === callerPub && !mp.dead);
    if (!related) return json([403, { error: 'unknown peer' }]);
    try {
      const av = await immich(`/users/${m[1]}/profile-image`);
      return {
        status: 200,
        headers: { 'content-type': av.headers.get('content-type') || 'image/jpeg' },
        body: Buffer.from(await av.arrayBuffer()),
      };
    } catch {
      return json([404, { error: 'no avatar' }]);
    }
  }
  if ((m = path.match(/^\/assets\/([^/]+)\/(preview|original|playback)$/))) {
    return servePeerBytes(callerPub, m[1], m[2] as 'preview' | 'original' | 'playback', range);
  }
  return json([404, { error: 'unknown route' }]);
};
