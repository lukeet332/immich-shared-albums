/**
 * invariants.test.ts — the fast lane. `npm test`, no containers, no network, milliseconds.
 *
 * This deliberately covers ONLY pure logic and the invariants that have actually broken. It is
 * not a second e2e suite: the mock rig in demo/ owns anything involving Immich, and duplicating
 * that here would be maintenance for no gain. If a test needs a container, it belongs there.
 *
 * Every case below is a bug that shipped or nearly shipped, kept as a guard rather than a wish.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_PREFIX, markerName, isUtilityEmail, UTILITY_EMAIL_DOMAIN, UTILITY_SUFFIX } from './config.ts';
import { permissionFor } from './sync/invites.ts';
import { diffInvitees } from './sync/invitees.ts';

test('bot namespaces are disjoint — no prefix may prefix another', () => {
  // The mirror/withdraw ping-pong came from one bot serving two roles. Detection reads "this bot
  // is an album member" as human intent, which is only sound for bots the sidecar never adds
  // itself. If one prefix were a prefix of another, a startsWith() check would match both.
  const prefixes = Object.values(BOT_PREFIX);
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a === b) continue;
      assert.ok(!a.startsWith(b), `${a} starts with ${b} — namespaces would overlap`);
    }
  }
});

test('a marker name never collides with an attribution contributor name', () => {
  // Two identically-named users are unpickable in Immich's album picker. A marker and a
  // contributor can exist for the SAME remote person on the same server.
  const person = 'Nan',
    peer = 'The Smiths';
  const marker = markerName.person(person, peer);
  const contributor = `${person}${UTILITY_SUFFIX}`;
  assert.notEqual(marker, contributor);
  assert.ok(!marker.includes(UTILITY_SUFFIX), 'markers must not wear the contributor suffix');
});

test('isUtilityEmail accepts only the project domain', () => {
  assert.ok(isUtilityEmail(`shared-x@${UTILITY_EMAIL_DOMAIN}`));
  assert.ok(isUtilityEmail(`invite-person-a-b@${UTILITY_EMAIL_DOMAIN}`));
  assert.ok(!isUtilityEmail('someone@sidecar.local'), 'v1 dropped the legacy domain');
  assert.ok(!isUtilityEmail('real.person@example.com'));
  assert.ok(!isUtilityEmail(undefined));
  // a lookalike domain must not pass
  assert.ok(!isUtilityEmail(`x@evil-${UTILITY_EMAIL_DOMAIN}.example.com`));
});

test('album roles map to share permissions', () => {
  assert.equal(permissionFor('editor'), 'contribute');
  assert.equal(permissionFor('viewer'), 'view');
  assert.equal(permissionFor(undefined), 'view', 'unknown roles must fail closed');
});

test('diffInvitees adds and removes, and never touches non-local users', () => {
  // Removal is the half that matters: dropping one person while others remain is a revocation.
  // Without it the sender's action appears to work and silently does nothing.
  const local = ['nan', 'second'];
  assert.deepEqual(diffInvitees({ wanted: ['nan', 'second'], current: ['nan'], local }), {
    add: ['second'],
    remove: [],
  });
  assert.deepEqual(diffInvitees({ wanted: ['second'], current: ['nan', 'second'], local }), {
    add: [],
    remove: ['nan'],
  });
  // a utility user holding the mirror is not in `local` and must never be removed
  assert.deepEqual(diffInvitees({ wanted: ['nan'], current: ['nan', 'bot-owner'], local }), {
    add: [],
    remove: [],
  });
  // an invitee we have no local account for is simply skipped
  assert.deepEqual(diffInvitees({ wanted: ['ghost'], current: [], local }), {
    add: [],
    remove: [],
  });
});

test('an empty invitee list is never treated as "remove everyone"', () => {
  // "Nobody named" means a withdrawal, handled by tearing the mirror down as a whole. If it were
  // treated as a diff, a failed or empty poll would silently strip every member instead.
  assert.deepEqual(diffInvitees({ wanted: [], current: ['nan'], local: ['nan'] }), {
    add: [],
    remove: [],
  });
});
