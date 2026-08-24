/**
 * p2p/pair.ts — linking two servers, as its own act.
 *
 * The pairing string is the ONE ticket-shaped moment in the product: it carries this server's
 * endpoint (public key + dial hints) and a single-use secret. After it, every share is native.
 * Being purpose-built is what lets it be strict:
 *
 *  - **single-use** — consumed the moment it is redeemed, so a forwarded copy is inert;
 *  - **short-lived** — panel-configurable, minutes-to-a-day, default 15 minutes;
 *  - **high-entropy** — 32 random bytes, so guessing is not a threat model;
 *  - **shown once** — only a hash persists, so not even this server can re-display a ticket;
 *  - **revocable before use** — the panel can drop an unredeemed code;
 *  - **not an album grant** — pairing conveys no access to any photo. What the two servers may
 *    see of each other is decided afterwards, per person, in Immich's own picker.
 *
 * One line, no URL: it dials keys, not addresses, so nothing needs to be exposed anywhere.
 * It still has to survive WhatsApp intact — single line, nothing a messenger linkifies.
 */
import crypto from 'node:crypto';
import { CFG, log, SIDECAR_VERSION } from '../config.ts';
import { store as kvStore } from '../state.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save, store, keys } from '../state.ts';
import { peerByPub } from '../peers.ts';
import { localAddr, peerRequest } from './transport.ts';

/** How long a freshly minted code stays redeemable — panel-configurable, because "long
 *  enough to paste into a chat" differs between a live call and a time-zoned family. */
const DEFAULT_TTL_MINUTES = 15;
export const TTL_MINUTES = { min: 5, max: 24 * 60 };
export function pairingTtlMinutes(): number {
  const v = (kvStore.kv('settings') as { pairingTtlMinutes?: number } | null)?.pairingTtlMinutes;
  return typeof v === 'number' && v >= TTL_MINUTES.min && v <= TTL_MINUTES.max ? v : DEFAULT_TTL_MINUTES;
}

/** Only a HASH of the secret is stored: the ticket is displayable exactly once, at mint.
 *  Nothing that can redeem a pairing ever rests in state.db. */
export type PairingCode = { codeHash: string; createdAt: number; expiresAt: number };
const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('base64url');

const load = (): PairingCode[] => store.kv('pairings') ?? [];
const persist = (list: PairingCode[]) => store.kvSet('pairings', list);

/** Drop anything expired. Called on every read path so stale codes cannot pile up. */
function live(): PairingCode[] {
  const now = Date.now();
  const list = load().filter(p => p.expiresAt > now);
  if (list.length !== load().length) persist(list);
  return list;
}

type Ticket = { v: 2; pub: string; relay?: string; addrs?: string[]; secret: string };

const ticketString = (secret: string): string => {
  const addr = localAddr();
  const ticket: Ticket = {
    v: 2,
    pub: keys.pub,
    relay: addr.relayUrl() ?? undefined,
    addrs: addr.directAddresses(),
    secret,
  };
  return `isa2-${Buffer.from(JSON.stringify(ticket)).toString('base64url')}`;
};

export const parseTicket = (raw: string): Ticket | null => {
  const m = String(raw ?? '')
    .trim()
    .match(/^isa2-([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const t = JSON.parse(Buffer.from(m[1], 'base64url').toString());
    return t?.v === 2 && t.pub && t.secret ? t : null;
  } catch {
    return null;
  }
};

/** Mint a code and return the ticket to hand to the other admin — the ONE time it is
 *  visible. Only its hash persists, so nothing can re-display it, us included. */
export function mintPairing(): { link: string; expiresAt: number } {
  const code = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttlMs = pairingTtlMinutes() * 60 * 1000;
  const entry = { codeHash: hashCode(code), createdAt: now, expiresAt: now + ttlMs };
  persist([...live(), entry]);
  log(`minted a pairing code, valid for ${ttlMs / 60000} minutes`);
  return { link: ticketString(code), expiresAt: entry.expiresAt };
}

/** What the panel shows: unredeemed codes, newest first — metadata only, never the ticket. */
export const pendingPairings = () =>
  live()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({ id: p.codeHash.slice(0, 12), createdAt: p.createdAt, expiresAt: p.expiresAt }));

/** Revoke by the ticket itself (paste-back) or by a pending entry's id. */
export function revokePairing(codeOrId: string) {
  const asHash = hashCode(codeOrId);
  persist(live().filter(p => p.codeHash !== asHash && p.codeHash.slice(0, 12) !== codeOrId));
}

/** Hashes are fixed-length, so this stays constant-time without the length dance. */
function codeMatches(candidate: string): PairingCode | undefined {
  const want = Buffer.from(hashCode(candidate));
  return live().find(p => crypto.timingSafeEqual(Buffer.from(p.codeHash), want));
}

/**
 * MINTING side: another server is redeeming a code we issued. The connection already proved
 * the caller holds the key being enrolled — the secret proves an admin here invited them.
 * Consuming the code before answering means a replay finds nothing.
 */
export async function handlePair(callerPub: string, body: string) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [400, { error: 'malformed request' }];
  }
  const { code, household } = parsed;
  if (!code || !household?.name) return [400, { error: 'malformed pairing request' }];
  const entry = codeMatches(String(code));
  if (!entry) {
    log('pairing refused: unknown or expired code');
    return [403, { error: 'that pairing link is not valid — it may have expired or been used' }];
  }
  // Single-use: burn it before doing anything else, so a replay cannot land twice.
  persist(live().filter(p => p.codeHash !== entry.codeHash));

  const existing = peerByPub(callerPub);
  if (existing) {
    existing.name = household.name || existing.name;
    if (parsed.version) existing.version = parsed.version;
  } else {
    state.peers.push({
      pub: callerPub,
      name: household.name || 'Unnamed household',
      version: parsed.version,
      via: 'pair',
      firstSeenAt: new Date().toISOString(),
    });
  }
  save();
  log(`paired with "${household.name}" — their people can now be invited to albums`);
  return [
    200,
    {
      household: { publicKey: keys.pub, name: CFG.name },
      protocol: PROTOCOL_VERSION,
      version: SIDECAR_VERSION,
    },
  ];
}

/**
 * REDEEMING side: an admin pasted a ticket another server gave them.
 *
 * One round trip pairs both ends: they learn our key from the connection itself, we learn
 * theirs from the ticket — and the dial only succeeds if the far end HOLDS that key, so the
 * identity in the ticket is verified by connecting, not by trusting the answer.
 */
export async function redeemPairing(rawTicket: string) {
  const ticket = parseTicket(rawTicket);
  if (!ticket) throw new Error('that does not look like a server link');
  if (ticket.pub === keys.pub)
    throw new Error('that is this server’s own link — paste it on the other server');
  const origin: import('../store.ts').Peer = {
    pub: ticket.pub,
    name: 'pairing',
    via: 'pair',
    firstSeenAt: new Date().toISOString(),
    relayHint: ticket.relay,
    lastAddrs: ticket.addrs,
  };
  const r = await peerRequest(origin, '/pair', {
    code: ticket.secret,
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    household: { name: CFG.name },
  });
  if (r.status >= 400) throw new Error(r.json?.error || `pairing failed (${r.status})`);
  if (!r.json?.household?.name) throw new Error('that server did not identify itself');

  const existing = peerByPub(ticket.pub);
  if (existing) {
    existing.name = r.json.household.name || existing.name;
    if (r.json.version) existing.version = r.json.version;
    existing.relayHint = ticket.relay;
    existing.lastAddrs = ticket.addrs;
  } else {
    state.peers.push({
      pub: ticket.pub,
      name: r.json.household.name || 'Unnamed household',
      version: r.json.version,
      via: 'pair',
      firstSeenAt: new Date().toISOString(),
      relayHint: ticket.relay,
      lastAddrs: ticket.addrs,
    });
  }
  save();
  log(`paired with "${r.json.household.name}" — their people can now be invited to albums`);
  return { linked: r.json.household.name };
}
