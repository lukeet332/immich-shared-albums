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
import {
  BOT_PREFIX,
  markerName,
  isUtilityEmail,
  UTILITY_EMAIL_DOMAIN,
  LEGACY_UTILITY_DOMAINS,
  UTILITY_SUFFIX,
} from './config.ts';
import { personName } from './config.ts';
import { permissionFor } from './sync/invites.ts';
import { diffInvitees } from './sync/invitees.ts';
import { jpegOfSize, boundedStubDims } from './media/jpeg.ts';

test('bot accounts are keyed by id, never by display name', () => {
  // Two remote people who share a display name must never collapse into one local account
  // sharing one API key — the state key embeds the person's user id on their own server.
  // (The old slugify(displayName) fallback also let a person named "Person 5" slug INTO the
  // person- namespace that unlink trusts for deletion.)
  const prefixes = Object.values(BOT_PREFIX);
  assert.deepEqual(prefixes, ['person-'], 'one namespace, one keying rule');
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

test('marker name does not stack "server" when the household already ends in one', () => {
  assert.equal(markerName.person('Nan', 'The Smiths'), 'Nan (via The Smiths server)');
  assert.equal(markerName.person('Nan', "Bob's server"), "Nan (via Bob's server)");
  assert.equal(markerName.person('Nan', 'My Server'), 'Nan (via My Server)'); // case-insensitive
  // and personName still recovers the human whichever form was used
  assert.equal(personName(markerName.person('Nan', "Bob's server")), 'Nan');
  assert.equal(personName(markerName.person('Nan', 'The Smiths')), 'Nan');
});

test('isUtilityEmail accepts the current domain and every legacy domain', () => {
  // Post-v1 the domain moved (.invalid -> .internal) WITH a migration, not as a clean break — so,
  // unlike v1, isUtilityEmail must still recognise legacy bots. Otherwise an existing bot is misread
  // as a human and gets added to mirrors / counted as real photos until migrate-domain renames it.
  assert.equal(
    UTILITY_EMAIL_DOMAIN,
    'immich-shared-albums.internal',
    'current domain reads as "internal", not "invalid"'
  );
  assert.ok(isUtilityEmail(`person-x@${UTILITY_EMAIL_DOMAIN}`));
  for (const d of LEGACY_UTILITY_DOMAINS)
    assert.ok(isUtilityEmail(`person-x@${d}`), `legacy ${d} is still a bot`);
  assert.ok(isUtilityEmail('shared-admin@sidecar.local'), 'v0 bots still recognised');
  assert.ok(isUtilityEmail('person-x@immich-shared-albums.invalid'), 'v1 bots still recognised');
  assert.ok(!isUtilityEmail('real.person@example.com'));
  assert.ok(!isUtilityEmail(undefined));
  // a lookalike domain must not pass — the leading "@" is required, so neither a suffix hack nor a
  // subdomain of our domain is a match.
  assert.ok(!isUtilityEmail(`x@evil-${UTILITY_EMAIL_DOMAIN}.example.com`));
  assert.ok(!isUtilityEmail(`x@evil.${UTILITY_EMAIL_DOMAIN}`));
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

test('personName recovers the human, however the account was decorated', () => {
  // Names travel on the wire. Stripping only UTILITY_SUFFIX let a marker's "(via X server)" ride
  // along as the "true" contributor, and each relay hop appended another layer:
  // "Nan (via B server) (via shared albums)". Collapse it in one pass, whatever the nesting.
  assert.equal(personName('Nan'), 'Nan');
  assert.equal(personName(`Nan${UTILITY_SUFFIX}`), 'Nan');
  assert.equal(personName('Nan (via The Smiths server)'), 'Nan');
  // household names contain brackets of their own — the strip must not stop at the inner one
  assert.equal(personName('Nan (via Demo household (B) server)'), 'Nan');
  // the compounded form seen in run27, which is what this exists to prevent
  assert.equal(personName('Nan (via Demo household (B) server) (via shared albums)'), 'Nan');
  assert.equal(personName(undefined), '');
});

test('mirror stub JPEG declares the origin aspect ratio, not 1x1', () => {
  // A fixed 1x1 stub made Immich lay every mirrored photo out square (grid) / letterboxed (viewer).
  // jpegOfSize must emit a valid baseline JPEG whose SOF0 carries the origin's aspect. Parse the
  // SOF0 marker directly — no JPEG decoder dependency.
  const sofDims = (buf: Buffer) => {
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xc0) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      if (marker === 0xd8 || marker === 0xd9) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  };
  for (const [w, h] of [
    [4000, 3000],
    [3000, 4000],
    [1000, 1000],
    [4032, 3024],
    [100, 50],
    [7, 13],
  ]) {
    const buf = jpegOfSize(w, h);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8, 'starts with SOI');
    assert.equal(buf[buf.length - 2], 0xff);
    assert.equal(buf[buf.length - 1], 0xd9, 'ends with EOI');
    const [bw, bh] = boundedStubDims(w, h);
    assert.deepEqual(sofDims(buf), { w: bw, h: bh }, `SOF matches bounded dims for ${w}x${h}`);
    assert.ok(bw <= 256 && bh <= 256, 'capped to <=256 on the long edge');
    assert.ok(Math.abs(bw / bh / (w / h) - 1) < 0.02, `aspect preserved for ${w}x${h}`);
    assert.ok(buf.length < 4096, `stub stays tiny (${buf.length}B for ${w}x${h})`);
  }
});
