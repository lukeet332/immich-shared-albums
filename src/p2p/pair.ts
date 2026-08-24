/**
 * p2p/pair.ts — linking two servers, as its own act.
 *
 * The pairing string is the ONE ticket-shaped moment in the product: it carries this server's
 * endpoint (public key + dial hints) and a single-use secret. After it, every share is native.
 * Being purpose-built is what lets it be strict:
 *
 *  - **single-use** — consumed the moment it is redeemed, so a forwarded copy is inert;
 *  - **short-lived** — minutes, not the 24 hours an Immich share-link token lives;
 *  - **high-entropy** — 32 random bytes, so guessing is not a threat model;
 *  - **revocable before use** — the panel can drop an unredeemed code;
 *  - **not an album grant** — pairing conveys no access to any photo. What the two servers may
 *    see of each other is decided afterwards, per person, in Immich's own picker.
 *
 * One line, no URL: it dials keys, not addresses, so nothing needs to be exposed anywhere.
 * It still has to survive WhatsApp intact — single line, nothing a messenger linkifies.
 */
import crypto from 'node:crypto';
import { CFG, log, SIDECAR_VERSION } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save, store, keys } from '../state.ts';
import { peerByPub } from '../peers.ts';
import { localAddr, peerRequest } from './transport.ts';

/** How long a freshly minted code stays redeemable. Long enough to paste into a chat. */
const CODE_TTL_MS = 15 * 60 * 1000;

export type PairingCode = { code: string; createdAt: number; expiresAt: number };

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

/** Mint a code and return the ticket to hand to the other admin. */
export function mintPairing(): { link: string; expiresAt: number } {
  const code = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const entry = { code, createdAt: now, expiresAt: now + CODE_TTL_MS };
  persist([...live(), entry]);
  log(`minted a pairing code, valid for ${CODE_TTL_MS / 60000} minutes`);
  return { link: ticketString(code), expiresAt: entry.expiresAt };
}

/** What the panel shows: unredeemed codes, newest first. */
export const pendingPairings = () =>
  live()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({ link: ticketString(p.code), expiresAt: p.expiresAt }));

export function revokePairing(code: string) {
  persist(live().filter(p => p.code !== code));
}

/** Constant-time, so a wrong code leaks nothing about how wrong it was. */
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
  revokePairing(entry.code);

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
