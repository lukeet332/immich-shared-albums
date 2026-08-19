/**
 * peers.ts — peer-to-peer transport primitives: detached-signature sign/verify over the
 * ed25519 household keypair, the signed POST helper, and the fire-and-forget nudge.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { state } from './state.ts';
import { CFG, ROUTE_PREFIX } from './config.ts';

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT, which is also the tailnet range
];
const isPrivateAddress = (ip: string) =>
  PRIVATE_V4.some(re => re.test(ip)) ||
  ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);

/**
 * Guard a peer-supplied URL before we fetch it. Private destinations are normal for LAN
 * and tailnet deployments, so they are allowed unless ALLOW_PRIVATE_PEERS=false — which is
 * what a public-facing host should set, so that a peer URL cannot be aimed at services
 * only the container can reach.
 */
export async function assertPeerUrlAllowed(rawUrl: string) {
  if (CFG.allowPrivatePeers) return;
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('that does not look like a valid server address'); }
  if (u.protocol !== 'https:') throw new Error('peer servers must be reached over https');
  let address: string;
  try { ({ address } = await dns.lookup(u.hostname)); }
  catch { throw new Error(`cannot resolve ${u.hostname}`); }
  if (isPrivateAddress(address)) throw new Error(`${u.hostname} resolves to a private address`);
}

export const sign = (body) => crypto.sign(null, Buffer.from(body),
  crypto.createPrivateKey({ key: Buffer.from(state.keys.priv, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url');
export const verify = (body, sig, pub) => {
  try {
    return crypto.verify(null, Buffer.from(body), crypto.createPublicKey({
      key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64url'));
  } catch { return false; }
};
/**
 * The peer behind an inbound request, or null. A key names a peer; only the signature
 * proves it, so these two always travel together — never match on the key alone, since
 * every public key is published in redeem responses.
 */
export function callingPeer(req, signedValue: string) {
  const peerKey = req.headers['x-isa-key'] as string;
  if (!peerKey) return null;
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer) return null;
  return verify(signedValue, req.headers['x-isa-sig'] as string || '', peerKey) ? peer : null;
}
/**
 * Find one of THIS peer's mappings. The `m.peer === peerPub` term is the whole point:
 * without it a mapping id alone selects an album, and any enrolled peer can act on a
 * relationship that belongs to a different household.
 */
export function mappingFor(peerPub: string, ref: string, role?: 'owner' | 'member') {
  return state.mappings.find(m => m.peer === peerPub
    && (!role || m.role === role)
    && (m.id === ref || m.albumId === ref || m.remoteAlbumId === ref));
}
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
    signedFetch(`${peer.url}${ROUTE_PREFIX}/api/v1/albums/${albumId}/nudge`, JSON.stringify({ album: albumId }))
      .catch(() => { /* fail-open */ });
  }
}
