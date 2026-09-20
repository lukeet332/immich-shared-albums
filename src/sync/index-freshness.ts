/** sync/index-freshness.ts — offering a person's albums to linked peers from the traffic they already make. See sync-loops.md. */

import crypto from 'node:crypto';
import { isUtilityEmail, log } from '../config.ts';
import { immichJson } from '../immich/client.ts';
import { credsFromHeaders, readCallerAlbums, type Creds } from '../immich/access.ts';
import { state, store } from '../state.ts';
import { nudgePeerIndex } from '../peers.ts';
import { offerAlbumsTo } from './album-index.ts';
import { albumsIPublish, type OwnedAlbum } from './matches.ts';
import { indexChanged, shouldRefresh } from './index-offer.ts';

/** Credentials already seen, keyed by a fingerprint — the credential itself is never retained.
 *  `userId` is resolved once per session, which is what keeps a refresh down to a single call. */
type Visit = {
  lastVisitAt: number;
  lastRefreshAt: number;
  refreshesWithNoChange: number;
  userId?: string;
  running: boolean;
  /** A change arrived while a read was in flight: read again as soon as it lands, or an add-photos
   *  burst would be published only up to wherever the first read happened to get to. */
  again: boolean;
};
const visits = new Map<string, Visit>();
const fingerprint = (headers: Record<string, string>) =>
  crypto.createHash('sha256').update(JSON.stringify(headers)).digest('base64url').slice(0, 16);

/** Forget every session, so the next request looks like the first one. Test hook only: the quiet
 *  period is fifteen minutes, which no test can wait out. */
export const forgetVisits = () => visits.clear();

/**
 * A request that may have moved this person's albums: read them again, if it is worth reading.
 *
 * Called on the way past, never in the way of it — the proxy streams uploads through here. An album
 * MUTATION is the index changing, so it is read at once (coalesced, because adding twenty photos is
 * one event in twenty requests); a SESSION marker is a person arriving, so it is read when the
 * window allows.
 */
export function noteIndexTraffic(trigger: 'index' | 'session', headers): void {
  if (!state.peers.length) return;
  const creds = credsFromHeaders(headers);
  if (!creds) return;
  scheduleRefresh(fingerprint(creds.headers), creds, trigger === 'index');
}

/** Start a read for this credential, unless one is already running.
 *
 *  `forced` means the request already told us the index moved (an album mutation), so the window
 *  does not get a vote. A change arriving mid-read is remembered rather than dropped: adding twenty
 *  photos is one event spread over twenty requests, and a read that started on the first must not
 *  be the only one. */
function scheduleRefresh(key: string, creds: Creds, forced: boolean): void {
  const now = Date.now();
  const seen = visits.get(key);
  if (seen?.running) {
    if (forced) seen.again = true;
    return;
  }
  if (seen && !forced && !shouldRefresh(seen, now)) {
    seen.lastVisitAt = now;
    return;
  }
  visits.set(key, {
    lastVisitAt: now,
    lastRefreshAt: now,
    refreshesWithNoChange: seen?.refreshesWithNoChange ?? 0,
    userId: seen?.userId,
    running: true,
    again: false,
  });
  if (visits.size > 100) forgetStaleVisits(now);
  void (async () => {
    try {
      const visit = visits.get(key);
      const changed = await offerAlbumsFrom(creds, visit?.userId, id => {
        if (visit) visit.userId = id;
      });
      // The window answers to the evidence: a change means this person is working on their library
      // and the next look is worth a minute; nothing means the wait doubles.
      if (visit) visit.refreshesWithNoChange = changed || forced ? 0 : visit.refreshesWithNoChange + 1;
    } catch (e) {
      log(`album index refresh from a visit failed: ${e.message}`);
    } finally {
      const visit = visits.get(key);
      if (visit) {
        const again = visit.again;
        visit.running = false;
        visit.again = false;
        if (again) scheduleRefresh(key, creds, true);
      }
    }
  })();
}

/** Drop sessions nobody has touched in a day. The map is keyed by a rotating cookie, so an
 *  unbounded one grows with every sign-in. */
function forgetStaleVisits(now: number) {
  for (const [key, visit] of visits) if (now - visit.lastVisitAt > 24 * 60 * 60 * 1000) visits.delete(key);
}

/** Read this person's albums as them and offer them to every linked peer. Returns whether a peer
 *  was actually told to look again, which is the only evidence the window is allowed to react to. */
export async function offerAlbumsFrom(
  creds: Creds,
  knownUserId?: string,
  rememberUserId?: (id: string) => void
): Promise<boolean> {
  const userId = knownUserId ?? (await userIdFor(creds));
  if (!userId) return false; // not a person: nothing of ours to offer
  if (!knownUserId) rememberUserId?.(userId);
  return offerToEveryPeer(albumsIPublish(await readCallerAlbums(creds), userId), userId) > 0;
}

/** The person behind a credential, or undefined when Immich will not resolve it or it turns out to
 *  be one of our own accounts. */
async function userIdFor(creds: Creds): Promise<string | undefined> {
  const me = await immichJson('/users/me', {}, creds).catch(() => null);
  return me?.id && !isUtilityEmail(me.email) ? String(me.id) : undefined;
}

/**
 * The admin account's own albums, read with the configured key.
 *
 * The admin IS a person here — an account this addon minted for itself is never the configured
 * key's owner — so this is what lets a link be useful the moment it exists, with no session in
 * hand: the peer that just paired is told what to match against before anyone opens a panel.
 */
export async function offerAdminAlbums(): Promise<boolean> {
  const me = await immichJson('/users/me').catch(() => null);
  if (!me?.id || isUtilityEmail(me.email)) return false;
  // NO creds argument: `immichJson`'s default IS the configured admin key, and passing an empty
  // credential instead is how this read answered `401 Authentication required` and left a fresh
  // link with nothing offered on the side that minted it.
  const albums = await immichJson('/albums').catch(() => null);
  if (!Array.isArray(albums)) return false;
  return offerToEveryPeer(albumsIPublish(albums, me.id), me.id) > 0;
}

/** Offer one person's albums to every peer, nudging only the peers whose view actually changed. */
function offerToEveryPeer(mine: OwnedAlbum[], ownerUserId: string): number {
  let nudged = 0;
  for (const peer of state.peers) {
    const before = store.publishedAlbumsFor(peer.pub, 'to-them').filter(a => a.ownerUserId === ownerUserId);
    // UNCHANGED IS FREE: no row is rewritten and no peer is dialled, so a refresh that finds the
    // same albums costs the two reads above and nothing else. That is what makes the ceiling cheap.
    if (!indexChanged(before, mine)) continue;
    offerAlbumsTo(mine, ownerUserId, peer.pub);
    nudgePeerIndex(peer);
    nudged++;
  }
  if (nudged) log(`offered ${mine.length} album(s) — told ${nudged} peer(s) to look again`);
  return nudged;
}
