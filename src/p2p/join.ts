/** p2p/join.ts — the member side of joining: redeem a share link, pin the peer, mirror the album. See wire-protocol.md. */
import { CFG, SIDECAR_VERSION, log, ROUTE_PREFIX } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, keys } from '../state.ts';
import { signedFetch, assertPeerUrlAllowed } from '../peers.ts';
import { ensureMirror, fillMirrorInBackground } from './mirror.ts';

export async function join(shareUrl, forUserId, password?: string) {
  const parsed = String(shareUrl ?? '')
    .trim()
    .match(/^(https?:\/\/[^/]+)\/share\/([A-Za-z0-9_-]+)/);
  if (!parsed) throw new Error('that does not look like an Immich share link');
  const [, origin, shareKey] = parsed;
  await assertPeerUrlAllowed(origin);
  const body = JSON.stringify({
    shareKey,
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    password,
    household: { publicKey: keys.pub, url: CFG.publicUrl, name: CFG.name },
  });
  const response = await signedFetch(`${origin}${ROUTE_PREFIX}/api/v1/invites/redeem`, body);
  if (!response.ok) {
    const reply = await response.json().catch(() => null);
    const clean = typeof reply?.error === 'string' ? reply.error.slice(0, 200) : null;
    const err = new Error(clean || `the other server refused the join (${response.status})`);
    if (reply?.passwordRequired) (err as Error & { passwordRequired?: boolean }).passwordRequired = true;
    throw err;
  }
  const redeemed = await response.json();
  if (redeemed.protocol && redeemed.protocol > PROTOCOL_VERSION)
    log(
      `origin "${redeemed.household?.name}" speaks protocol ${redeemed.protocol} > ours (${PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server`
    );
  if (!state.peers.some(p => p.pub === redeemed.household.publicKey)) {
    state.peers.push({
      pub: redeemed.household.publicKey,
      url: redeemed.household.url,
      name: redeemed.household.name,
      version: redeemed.version,
    });
  }
  const peer = state.peers.find(pe => pe.pub === redeemed.household.publicKey);
  if (!peer) throw new Error('peer record vanished during join — retry');
  const { mapping, created } = await ensureMirror({
    peer,
    album: { id: redeemed.album.id, name: redeemed.album.name },
    permissions: redeemed.album.permissions,
    albumOwnerName: redeemed.albumOwner?.displayName,
    albumOwnerId: redeemed.albumOwner?.originUserId,
    remoteMappingId: redeemed.mappingId,
    forUserIds: forUserId ? [forUserId] : undefined,
  });
  log(
    created
      ? `joined "${redeemed.album.name}" from "${redeemed.household.name}" (${redeemed.manifest.length} photos)`
      : `re-join: "${mapping.albumName}" already mirrored from "${redeemed.household.name}"`
  );
  const peerRec = state.peers.find(pe => pe.pub === redeemed.household.publicKey);
  if (created && peerRec) fillMirrorInBackground(mapping, peerRec);
  return {
    album: mapping.albumName,
    albumId: mapping.albumId,
    photos: redeemed.manifest.length,
    from: redeemed.household.name,
    permissions: redeemed.album.permissions,
    mappingId: mapping.id,
  };
}
