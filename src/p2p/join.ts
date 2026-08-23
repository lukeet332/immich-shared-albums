/**
 * p2p/join.ts — the member side of joining. Dials the origin's endpoint (carried by the
 * invite), redeems the share key, pins the peer, provisions the host utility user, creates
 * the local mirror album, and kicks off the first reconcile. Idempotent: re-joining just
 * adds the user to the mirror.
 */
import { CFG, SIDECAR_VERSION, log } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state } from '../state.ts';
import { peerRequest } from './transport.ts';
import { ensureMirror, fillMirrorInBackground } from './mirror.ts';

export type JoinInvite = {
  /** The origin's endpoint: its public key plus dial hints. Carried by the share page. */
  endpoint: { pub: string; relay?: string; addrs?: string[] };
  key: string;
};

export async function join(invite: JoinInvite, forUserId, password?: string) {
  if (!invite?.endpoint?.pub || !invite?.key) throw new Error('that does not look like a share invite');
  const origin = {
    pub: invite.endpoint.pub,
    name: 'origin',
    relayHint: invite.endpoint.relay,
    lastAddrs: invite.endpoint.addrs,
  };
  const r = await peerRequest(origin, '/invites/redeem', {
    shareKey: invite.key,
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    password,
    household: { name: CFG.name },
  });
  if (r.status >= 400) {
    const clean = typeof r.json?.error === 'string' ? r.json.error.slice(0, 200) : null;
    const err = new Error(clean || `the other server refused the join (${r.status})`);
    if (r.json?.passwordRequired) (err as Error & { passwordRequired?: boolean }).passwordRequired = true;
    throw err;
  }
  const res = r.json;
  if (res.protocol && res.protocol > PROTOCOL_VERSION)
    log(
      `origin "${res.household?.name}" speaks protocol ${res.protocol} > ours (${PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server`
    );
  if (res.household.publicKey !== invite.endpoint.pub)
    throw new Error('the origin answered with a different identity than the invite named');
  if (!state.peers.some(p => p.pub === res.household.publicKey)) {
    state.peers.push({
      pub: res.household.publicKey,
      name: res.household.name,
      version: res.version,
      relayHint: invite.endpoint.relay,
      lastAddrs: invite.endpoint.addrs,
    });
  }
  // Pinned just above if it was missing, so this cannot be undefined — but find it once and
  // say so, rather than looking it up twice and pretending each result might be absent.
  const peer = state.peers.find(pe => pe.pub === res.household.publicKey);
  if (!peer) throw new Error('peer record vanished during join — retry');
  const { mapping, created } = await ensureMirror({
    peer,
    album: { id: res.album.id, name: res.album.name },
    permissions: res.album.permissions,
    albumOwnerName: res.albumOwner?.displayName,
    albumOwnerId: res.albumOwner?.originUserId,
    remoteMappingId: res.mappingId,
    // A link join is for one account when the panel/accept page names one, else the household.
    forUserIds: forUserId ? [forUserId] : undefined,
  });
  log(
    created
      ? `joined "${res.album.name}" from "${res.household.name}" (${res.manifest.length} photos)`
      : `re-join: "${mapping.albumName}" already mirrored from "${res.household.name}"`
  );
  const peerRec = state.peers.find(pe => pe.pub === res.household.publicKey);
  if (created && peerRec) fillMirrorInBackground(mapping, peerRec);
  return {
    album: mapping.albumName,
    albumId: mapping.albumId,
    photos: res.manifest.length,
    from: res.household.name,
    permissions: res.album.permissions,
    mappingId: mapping.id,
  };
}
