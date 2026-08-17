/**
 * peers.ts — peer-to-peer transport primitives: detached-signature sign/verify over the
 * ed25519 household keypair, the signed POST helper, and the fire-and-forget nudge.
 */
import crypto from 'node:crypto';
import { state } from './state.ts';

export const sign = (body) => crypto.sign(null, Buffer.from(body),
  crypto.createPrivateKey({ key: Buffer.from(state.keys.priv, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
export const verify = (body, sig, pub) => {
  try {
    return crypto.verify(null, Buffer.from(body), crypto.createPublicKey({
      key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64url'));
  } catch { return false; }
};
export const signedFetch = (url, body) => fetch(url, {
  signal: AbortSignal.timeout(30000),
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-isa-key': state.keys.pub, 'x-isa-sig': sign(body) },
  body,
});
// Nudge: tell every OTHER household mapped to this album that it moved, so they pull
// now instead of at their next tick. Fire-and-forget — a lost nudge costs nothing,
// the scheduled handshake still catches everything (fail-open by design).
export function nudgePeers(albumId: string, exceptPeerPub?: string) {
  for (const mp of state.mappings) {
    if (mp.albumId !== albumId || mp.dead || mp.role !== 'owner' || mp.peer === exceptPeerPub) continue;
    const peer = state.peers.find(p => p.pub === mp.peer);
    if (!peer) continue;
    signedFetch(`${peer.url}/sidecar/api/v1/albums/${albumId}/nudge`, JSON.stringify({ album: albumId }))
      .catch(() => { /* fail-open */ });
  }
}
