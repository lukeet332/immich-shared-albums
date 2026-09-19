/** adoption.test.ts — deciding whether an album offered for reunification may actually be adopted. See docs/post-v1-reunification-design.md §2. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAdoptableAlbum, type OfferToAdopt } from './adoption.ts';

/** An album in Immich's shape, owned by the given user. */
const album = (id: string, name: string, ownerId: string, over: Record<string, unknown> = {}) => ({
  id,
  albumName: name,
  assetCount: 10,
  albumUsers: [{ user: { id: ownerId, name: 'Someone' }, role: 'owner' }],
  ...over,
});

const offer = (name: string): OfferToAdopt => ({ albumName: name, peerOwnerUserId: 'them' });

test("the caller's own album with the offered name is adoptable", () => {
  const found = findAdoptableAlbum(offer('Summer 2024'), [album('a1', 'Summer 2024', 'me')], 'me');
  assert.equal(found?.albumId, 'a1');
});

// The id comes from the browser, so the server must never take it on trust: this function is the
// reason a malicious or buggy panel cannot hand us somebody else's album to merge into.
test('an album the caller does NOT own is refused, however the browser asked', () => {
  const found = findAdoptableAlbum(offer('Summer 2024'), [album('a1', 'Summer 2024', 'someone-else')], 'me');
  assert.equal(found, undefined, "adopting another person's album would put their photos in our share");
});

test('a different name is refused — adoption is the same match the panel showed', () => {
  const found = findAdoptableAlbum(offer('Summer 2024'), [album('a1', 'Winter 2019', 'me')], 'me');
  assert.equal(found, undefined, 'only a matched pair may be reunited');
});

// Matching is name-only, so case and spacing must not decide it — the same rule the matcher uses.
test('the name is compared the way the matcher compares it', () => {
  const found = findAdoptableAlbum(offer('  summer   2024 '), [album('a1', 'Summer 2024', 'me')], 'me');
  assert.equal(found?.albumId, 'a1');
});

test('an album with no owner entry is never adopted', () => {
  const ownerless = album('a1', 'Summer 2024', 'me', { albumUsers: [] });
  assert.equal(findAdoptableAlbum(offer('Summer 2024'), [ownerless], 'me'), undefined);
});

test('the caller having no such album yields nothing rather than a guess', () => {
  assert.equal(findAdoptableAlbum(offer('Summer 2024'), [], 'me'), undefined);
  assert.equal(findAdoptableAlbum(offer('Summer 2024'), [album('a1', 'Other', 'me')], 'me'), undefined);
});
