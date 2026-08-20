/**
 * p2p/join.ts — the member side of joining. Redeems a share link against the origin,
 * pins the peer, provisions the host utility user, creates the local mirror album, and
 * kicks off the first reconcile. Idempotent: re-joining just adds the user to the mirror.
 */
import { CFG, SIDECAR_VERSION, log, ROUTE_PREFIX } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state } from '../state.ts';
import { signedFetch, assertPeerUrlAllowed } from '../peers.ts';
import { ensureMirror, fillMirrorInBackground } from './mirror.ts';

export async function join(shareUrl, forUserId, password?: string) {
  const m = String(shareUrl ?? '')
    .trim()
    .match(/^(https?:\/\/[^/]+)\/share\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('that does not look like an Immich share link');
  const [, origin, shareKey] = m;
  await assertPeerUrlAllowed(origin);
  const body = JSON.stringify({
    shareKey,
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    password,
    household: { publicKey: state.keys.pub, url: CFG.publicUrl, name: CFG.name },
  });
  const r = await signedFetch(`${origin}${ROUTE_PREFIX}/api/v1/invites/redeem`, body);
  if (!r.ok) {
    // Surface the other sidecar's own message (an expired link, a wrong password) but
    // never an arbitrary upstream body — that would make this a read primitive for
    // whatever the URL actually pointed at.
    const reply = await r.json().catch(() => null);
    const clean = typeof reply?.error === 'string' ? reply.error.slice(0, 200) : null;
    const err = new Error(clean || `the other server refused the join (${r.status})`);
    if (reply?.passwordRequired) (err as Error & { passwordRequired?: boolean }).passwordRequired = true;
    throw err;
  }
  const res = await r.json();
  if (res.protocol && res.protocol > PROTOCOL_VERSION)
    log(
      `origin "${res.household?.name}" speaks protocol ${res.protocol} > ours (${PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server`
    );
  if (!state.peers.some(p => p.pub === res.household.publicKey)) {
    state.peers.push({
      pub: res.household.publicKey,
      url: res.household.url,
      name: res.household.name,
      version: res.version,
    });
  }
  const { mapping, created } = await ensureMirror({
    peer: state.peers.find(pe => pe.pub === res.household.publicKey),
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
