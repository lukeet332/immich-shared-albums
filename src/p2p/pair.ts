/**
 * p2p/pair.ts — linking two servers, as its own act.
 *
 * Until now a link only came into being as a side effect of redeeming an ALBUM share link, which
 * made enrolment bearer-based: whoever held that link (and its password) could attach their
 * server to yours, using a credential meant to grant one album to one person. This replaces that
 * with a purpose-built one, and being purpose-built is what lets it be strict:
 *
 *  - **single-use** — consumed the moment it is redeemed, so a forwarded copy is inert;
 *  - **short-lived** — minutes, not the 24 hours an Immich share-link token lives;
 *  - **high-entropy** — 32 random bytes, so guessing is not a threat model;
 *  - **revocable before use** — the panel can drop an unredeemed code;
 *  - **not an album grant** — pairing conveys no access to any photo. What the two servers may
 *    see of each other is decided afterwards, per person, in Immich's own picker.
 *
 * Nobody has to be able to *open* this string in a browser, which is exactly why it can be
 * tighter than the banner flow it sits alongside.
 */
import crypto from 'node:crypto';
import { CFG, log, ROUTE_PREFIX, SIDECAR_VERSION } from '../config.ts';
import { PROTOCOL_VERSION } from '../types.ts';
import { state, save, store, keys } from '../state.ts';
import { assertPeerUrlAllowed, verify, sign } from '../peers.ts';

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

/**
 * Mint a code and return the string to hand to the other admin.
 *
 * A URL, because that is the one shape a messenger will not mangle: no newlines, nothing that
 * gets linkified into something else, and it survives being pasted into WhatsApp or a text.
 * PUBLIC_URL has to be set for it to mean anything — the other server dials it.
 */
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

/** What the panel shows: unredeemed codes, newest first. */
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
 * MINTING side: another server is redeeming a code we issued.
 *
 * Signature-bound to the key being enrolled, exactly as album redeem is: it proves the caller
 * holds the private half of the identity it is asking us to trust, so the enrolled key cannot be
 * forged or swapped later. Consuming the code before answering means a replay finds nothing.
 */
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
  // Single-use: burn it before doing anything else, so a replay cannot land twice.
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

/**
 * REDEEMING side: an admin pasted a link another server gave them.
 *
 * One round trip pairs both ends: they learn our key from the signed request, we learn theirs
 * from the answer. Neither side gains access to a single photo by doing this — that is decided
 * afterwards, per person, in Immich's own album picker.
 */
export async function redeemPairing(link: string) {
  const m = String(link ?? '')
    .trim()
    .match(/^(https?:\/\/[^/]+)(?:\/[^#]*)?#([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('that does not look like a server link');
  const [, origin, code] = m;
  await assertPeerUrlAllowed(origin);

  const body = JSON.stringify({
    code,
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    household: { publicKey: keys.pub, url: CFG.publicUrl, name: CFG.name },
  });
  const r = await fetch(`${origin}${ROUTE_PREFIX}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-isa-key': keys.pub, 'x-isa-sig': sign(body) },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(res.error || `pairing failed (${r.status})`);
  if (!res.household?.publicKey) throw new Error('that server did not identify itself');

  const existing = state.peers.find(p => p.pub === res.household.publicKey);
  if (existing) {
    existing.url = res.household.url || origin;
    existing.name = res.household.name || existing.name;
    if (res.version) existing.version = res.version;
  } else {
    state.peers.push({
      pub: res.household.publicKey,
      url: res.household.url || origin,
      name: res.household.name || 'Unnamed household',
      version: res.version,
    });
  }
  save();
  log(`paired with "${res.household.name}" — their people can now be invited to albums`);
  return { linked: res.household.name || origin };
}
