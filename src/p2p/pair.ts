/** p2p/pair.ts — linking two servers, as its own act. See wire-protocol.md. */
import crypto from 'node:crypto';
import { CFG, log, ROUTE_PREFIX, SIDECAR_VERSION } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save, store, keys } from '../state.ts';
import { assertPeerUrlAllowed, verify, sign } from '../peers.ts';

const CODE_TTL_MS = 15 * 60 * 1000;

export type PairingCode = { code: string; createdAt: number; expiresAt: number };

const load = (): PairingCode[] => store.kv('pairings') ?? [];
const persist = (list: PairingCode[]) => store.kvSet('pairings', list);

function live(): PairingCode[] {
  const now = Date.now();
  const list = load().filter(p => p.expiresAt > now);
  if (list.length !== load().length) persist(list);
  return list;
}

export function mintPairing(): { link: string; expiresAt: number } {
  if (!CFG.publicUrl) {
    throw new Error('PUBLIC_URL is not set, so the other server would have no address to reach');
  }
  const code = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const entry = { code, createdAt: now, expiresAt: now + CODE_TTL_MS };
  persist([...live(), entry]);
  log(`minted a pairing code, valid for ${CODE_TTL_MS / 60000} minutes`);
  return { link: `${CFG.publicUrl}${ROUTE_PREFIX}/pair#${code}`, expiresAt: entry.expiresAt };
}

export const pendingPairings = () =>
  live()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({
      link: `${CFG.publicUrl}${ROUTE_PREFIX}/pair#${p.code}`,
      expiresAt: p.expiresAt,
    }));

export function revokePairing(code: string) {
  persist(live().filter(p => p.code !== code));
}

function codeMatches(candidate: string): PairingCode | undefined {
  const want = Buffer.from(candidate);
  return live().find(p => {
    const have = Buffer.from(p.code);
    if (have.length !== want.length) {
      crypto.timingSafeEqual(have, have);
      return false;
    }
    return crypto.timingSafeEqual(have, want);
  });
}

export async function handlePair(req, body: string) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [400, { error: 'malformed request' }];
  }
  const { code, household } = parsed;
  if (!code || !household?.publicKey || !household?.url) {
    return [400, { error: 'malformed pairing request' }];
  }
  if (!verify(body, (req.headers['x-isa-sig'] as string) || '', household.publicKey)) {
    return [403, { error: 'pairing signature does not match the household key' }];
  }
  const entry = codeMatches(String(code));
  if (!entry) {
    log('pairing refused: unknown or expired code');
    return [403, { error: 'that pairing link is not valid — it may have expired or been used' }];
  }
  try {
    await assertPeerUrlAllowed(household.url);
  } catch (e) {
    return [400, { error: e.message }];
  }
  revokePairing(entry.code);

  const existing = state.peers.find(p => p.pub === household.publicKey);
  if (existing) {
    existing.url = household.url;
    existing.name = household.name || existing.name;
    if (parsed.version) existing.version = parsed.version;
  } else {
    state.peers.push({
      pub: household.publicKey,
      url: household.url,
      name: household.name || 'Unnamed household',
      version: parsed.version,
    });
  }
  save();
  log(`paired with "${household.name}" — their people can now be invited to albums`);
  return [
    200,
    {
      household: { publicKey: keys.pub, url: CFG.publicUrl, name: CFG.name },
      protocol: PROTOCOL_VERSION,
      version: SIDECAR_VERSION,
    },
  ];
}

export async function redeemPairing(link: string) {
  const parsed = String(link ?? '')
    .trim()
    .match(/^(https?:\/\/[^/]+)(?:\/[^#]*)?#([A-Za-z0-9_-]+)$/);
  if (!parsed) throw new Error('that does not look like a server link');
  const [, origin, code] = parsed;
  await assertPeerUrlAllowed(origin);

  const body = JSON.stringify({
    code,
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    household: { publicKey: keys.pub, url: CFG.publicUrl, name: CFG.name },
  });
  const response = await fetch(`${origin}${ROUTE_PREFIX}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-isa-key': keys.pub, 'x-isa-sig': sign(body) },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error || `pairing failed (${response.status})`);
  if (!answer.household?.publicKey) throw new Error('that server did not identify itself');

  const existing = state.peers.find(p => p.pub === answer.household.publicKey);
  if (existing) {
    existing.url = answer.household.url || origin;
    existing.name = answer.household.name || existing.name;
    if (answer.version) existing.version = answer.version;
  } else {
    state.peers.push({
      pub: answer.household.publicKey,
      url: answer.household.url || origin,
      name: answer.household.name || 'Unnamed household',
      version: answer.version,
    });
  }
  save();
  log(`paired with "${answer.household.name}" — their people can now be invited to albums`);
  return { linked: answer.household.name || origin };
}
