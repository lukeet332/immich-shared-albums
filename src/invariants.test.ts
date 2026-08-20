/** invariants.test.ts — the fast lane: pure logic only, no containers. See ../AGENTS.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_PREFIX, markerName, isUtilityEmail, UTILITY_EMAIL_DOMAIN, UTILITY_SUFFIX } from './config.ts';
import { personName } from './config.ts';
import { permissionFor } from './sync/invites.ts';
import { diffInvitees } from './sync/invitees.ts';

test('bot namespaces are disjoint — no prefix may prefix another', () => {
  const prefixes = Object.values(BOT_PREFIX);
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a === b) continue;
      assert.ok(!a.startsWith(b), `${a} starts with ${b} — namespaces would overlap`);
    }
  }
});

test('a marker name never collides with an attribution contributor name', () => {
  // Two identically-named users are unpickable in Immich's album picker.
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
  assert.ok(!isUtilityEmail(`x@evil-${UTILITY_EMAIL_DOMAIN}.example.com`));
});

test('album roles map to share permissions', () => {
  assert.equal(permissionFor('editor'), 'contribute');
  assert.equal(permissionFor('viewer'), 'view');
  assert.equal(permissionFor(undefined), 'view', 'unknown roles must fail closed');
});

test('diffInvitees adds and removes, and never touches non-local users', () => {
  const local = ['nan', 'second'];
  assert.deepEqual(diffInvitees({ wanted: ['nan', 'second'], current: ['nan'], local }), {
    add: ['second'],
    remove: [],
  });
  assert.deepEqual(diffInvitees({ wanted: ['second'], current: ['nan', 'second'], local }), {
    add: [],
    remove: ['nan'],
  });
  assert.deepEqual(diffInvitees({ wanted: ['nan'], current: ['nan', 'bot-owner'], local }), {
    add: [],
    remove: [],
  });
  assert.deepEqual(diffInvitees({ wanted: ['ghost'], current: [], local }), {
    add: [],
    remove: [],
  });
});

test('an empty invitee list is never treated as "remove everyone"', () => {
  assert.deepEqual(diffInvitees({ wanted: [], current: ['nan'], local: ['nan'] }), {
    add: [],
    remove: [],
  });
});

test('personName recovers the human, however the account was decorated', () => {
  assert.equal(personName('Nan'), 'Nan');
  assert.equal(personName(`Nan${UTILITY_SUFFIX}`), 'Nan');
  assert.equal(personName('Nan (via The Smiths server)'), 'Nan');
  assert.equal(personName('Nan (via Demo household (B) server)'), 'Nan');
  assert.equal(personName('Nan (via Demo household (B) server) (via shared albums)'), 'Nan');
  assert.equal(personName(undefined), '');
});
