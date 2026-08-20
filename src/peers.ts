/** peers.ts — signing, verification and the signed fetch helpers. See peers.md. */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { state, keys } from './state.ts';
import { CFG, ROUTE_PREFIX } from './config.ts';

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT, which is also the tailnet range
];
const isPrivateAddress = (ip: string) =>
  PRIVATE_V4.some(re => re.test(ip)) ||
  ip === '::1' ||
  ip === '::' ||
  /^f[cd]/i.test(ip) ||
  /^fe80:/i.test(ip);

export async function assertPeerUrlAllowed(rawUrl: string) {
  if (CFG.allowPrivatePeers) return;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('that does not look like a valid server address');
  }
  if (u.protocol !== 'https:') throw new Error('peer servers must be reached over https');
  let address: string;
  try {
    ({ address } = await dns.lookup(u.hostname));
  } catch {
    throw new Error(`cannot resolve ${u.hostname}`);
  }
  if (isPrivateAddress(address)) throw new Error(`${u.hostname} resolves to a private address`);
}

export const sign = body =>
  crypto
    .sign(
      null,
      Buffer.from(body),
      crypto.createPrivateKey({
        key: Buffer.from(keys.priv, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      })
    )
    .toString('base64url');
export const verify = (body, sig, pub) => {
  try {
    return crypto.verify(
      null,
      Buffer.from(body),
      crypto.createPublicKey({
        key: Buffer.from(pub, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(sig, 'base64url')
    );
  } catch {
    return false;
  }
};
export function callingPeer(req, signedValue: string) {
  const peerKey = req.headers['x-isa-key'] as string;
  if (!peerKey) return null;
  const peer = state.peers.find(p => p.pub === peerKey);
  if (!peer) return null;
  return verify(signedValue, (req.headers['x-isa-sig'] as string) || '', peerKey) ? peer : null;
}
export function mappingFor(peerPub: string, ref: string, role?: 'owner' | 'member') {
  return state.mappings.find(
    m =>
      m.peer === peerPub &&
      (!role || m.role === role) &&
      (m.id === ref || m.albumId === ref || m.remoteAlbumId === ref)
  );
}
export const signedGet = (url: string, signedValue: string, init: RequestInit = {}) =>
  fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20000),
    headers: { ...(init.headers || {}), 'x-isa-key': keys.pub, 'x-isa-sig': sign(signedValue) },
  });
export const signedFetch = (url, body) =>
  fetch(url, {
    signal: AbortSignal.timeout(30000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-isa-key': keys.pub, 'x-isa-sig': sign(body) },
    body,
  });
export function nudgePeers(albumId: string, exceptPeerPub?: string) {
  for (const mp of state.mappings) {
    if (mp.albumId !== albumId || mp.dead || mp.role !== 'owner' || mp.peer === exceptPeerPub) continue;
    const peer = state.peers.find(p => p.pub === mp.peer);
    if (!peer) continue;
    signedFetch(
      `${peer.url}${ROUTE_PREFIX}/api/v1/albums/${albumId}/nudge`,
      JSON.stringify({ album: albumId })
    ).catch(() => {
      /* fail-open */
    });
  }
}
