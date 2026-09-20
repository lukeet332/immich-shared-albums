/** sync/index-freshness.test.ts — when a person's albums are offered, and to whom we say "look again". See sync-loops.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFER_BASE_MS,
  OFFER_MAX_MS,
  SESSION_QUIET_MS,
  indexChanged,
  offerWindowMs,
  opensSession,
  shouldRefresh,
} from './index-offer.ts';
import type { OwnedAlbum } from './matches.ts';

const album = (over: Partial<OwnedAlbum> = {}): OwnedAlbum => ({
  name: 'Summer 2024',
  assetCount: 6,
  startDate: '2024-06-10T00:00:00.000Z',
  endDate: '2024-08-11T00:00:00.000Z',
  ownerUserId: 'u-nan',
  ownerName: 'Demo Nan',
  ...over,
});

// ── WHEN WE READ ─────────────────────────────────────────────────────────────────────────────
// Reading someone's album list costs two calls against their Immich, so the rule is "the first
// request of a session, and nothing for the rest of it". A session ends when they stop talking.
test('the first request, with nothing seen before, opens a session', () => {
  assert.equal(opensSession(0, 1_700_000_000_000), true, 'a person never seen has never been read');
});

test('a request in the middle of a session does not read again', () => {
  const now = 1_700_000_000_000;
  assert.equal(opensSession(now - 1_000, now), false, 'one second later is the same session');
  assert.equal(opensSession(now - (SESSION_QUIET_MS - 1), now), false, 'one millisecond short is still it');
});

test('the first request after the quiet period opens the next session', () => {
  const now = 1_700_000_000_000;
  assert.equal(opensSession(now - SESSION_QUIET_MS, now), true, 'exactly the quiet period counts');
  assert.equal(opensSession(now - SESSION_QUIET_MS * 4, now), true, 'hours away is certainly a new one');
});

// ── WHEN WE NUDGE ────────────────────────────────────────────────────────────────────────────
// A nudge costs the peer a dial, so it is sent when the peer's view actually changed — not on
// every visit, and not when the same albums come back in a different order.
test('an unchanged list tells no peer to look again', () => {
  assert.equal(indexChanged([album()], [album()]), false);
});

test('the same albums in a different order are not a change', () => {
  const b = album({ name: 'Winter 2023' });
  assert.equal(indexChanged([album(), b], [b, album()]), false, 'Immich does not promise an order');
});

test('a new album is a change', () => {
  assert.equal(indexChanged([album()], [album(), album({ name: 'Winter 2023' })]), true);
});

test('an album that gained a photo is a change', () => {
  assert.equal(indexChanged([album()], [album({ assetCount: 7 })]), true, 'the count is what a peer prints');
});

test('a renamed album is a change', () => {
  assert.equal(indexChanged([album()], [album({ name: 'Summer 2024 (edited)' })]), true);
});

test('a withdrawn album is a change, so the peer stops matching against it', () => {
  assert.equal(indexChanged([album()], []), true);
});

// ── THE WINDOW, AND WHY IT MOVES ─────────────────────────────────────────────────────────────
// The window is a cost decision, and the cost is the payload: reading a person's album list is one
// call whose size grows with their library (~620 bytes an album, measured — see sync-loops.md), so a
// fixed fast cadence spends the same money on a library nobody touches as on one being built. The
// rule is therefore "stretch on evidence, snap back on change": silence doubles the wait up to the
// cap, and any change returns it to the base.
test('a window with no evidence of change backs off, and stops at the cap', () => {
  assert.equal(offerWindowMs(0), OFFER_BASE_MS, 'the first look after a change is a minute');
  assert.equal(offerWindowMs(1), OFFER_BASE_MS * 2);
  assert.equal(offerWindowMs(2), OFFER_BASE_MS * 4);
  assert.equal(offerWindowMs(3), OFFER_BASE_MS * 8);
  assert.equal(offerWindowMs(4), OFFER_MAX_MS, 'the cap is what bounds an idle library');
  assert.equal(offerWindowMs(50), OFFER_MAX_MS, 'and it stays bounded however long the silence');
});

test('a refresh is due only once its window has elapsed', () => {
  const now = 1_700_000_000_000;
  const quiet = { lastVisitAt: now - 1_000, lastRefreshAt: now, refreshesWithNoChange: 3 };
  assert.equal(shouldRefresh(quiet, now + offerWindowMs(3) - 1), false, 'one millisecond short');
  assert.equal(shouldRefresh(quiet, now + offerWindowMs(3)), true, 'the window is the whole wait');
});

test('a backed-off person who comes back is read at once', () => {
  const now = 1_700_000_000_000;
  assert.equal(
    shouldRefresh(
      { lastVisitAt: now - SESSION_QUIET_MS, lastRefreshAt: now - 1_000, refreshesWithNoChange: 9 },
      now
    ),
    true,
    'returning is evidence: the list may have moved while nobody was talking'
  );
});

test('a change drops the window back to the base, so work is followed closely', () => {
  // `refreshesWithNoChange` is reset to 0 by the caller when an offer changed (index-freshness.ts),
  // so the next look is a minute away rather than fifteen — this is the half of the rule that makes
  // a person building an album see it on the other server within about a minute.
  const now = 1_700_000_000_000;
  const justChanged = { lastVisitAt: now - 1_000, lastRefreshAt: now, refreshesWithNoChange: 0 };
  assert.equal(shouldRefresh(justChanged, now + OFFER_BASE_MS), true);
  assert.equal(shouldRefresh({ ...justChanged, refreshesWithNoChange: 4 }, now + OFFER_BASE_MS), false);
});
