/** sync/traffic-triggers.test.ts — what a request through the proxy tells us to do. See sync-loops.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trafficTriggerFor } from './traffic-triggers.ts';

// Measured: one sign-in and an albums view is 48 `/api` calls, nearly all of them the byte path for
// thumbnails. These three kinds are the only ones that say anything, and acting on them is what
// makes a change travel because it HAPPENED rather than because a timer came round.
test('creating an album is the index changing, observed rather than inferred', () => {
  assert.equal(trafficTriggerFor('POST', '/api/albums'), 'index');
});

test('changing an album is a change: rename, cover, delete, contents, people', () => {
  assert.equal(trafficTriggerFor('PUT', '/api/albums/abc'), 'index');
  assert.equal(trafficTriggerFor('PATCH', '/api/albums/abc'), 'index');
  assert.equal(trafficTriggerFor('DELETE', '/api/albums/abc'), 'index');
  assert.equal(trafficTriggerFor('PUT', '/api/albums/abc/assets'), 'index');
  assert.equal(trafficTriggerFor('PUT', '/api/albums/abc/users'), 'index');
  assert.equal(trafficTriggerFor('DELETE', '/api/albums/abc/user/xyz'), 'index', 'a person removed');
  assert.equal(trafficTriggerFor('POST', '/api/albums/abc/route-we-have-not-met'), 'index');
});

test('reading an album is not a change', () => {
  assert.equal(trafficTriggerFor('GET', '/api/albums/abc'), undefined, 'opening an album changes nothing');
  assert.equal(trafficTriggerFor('GET', '/api/albums'), undefined);
});

test('writing a comment is a comment, so the push does not wait out the poll', () => {
  assert.equal(trafficTriggerFor('POST', '/api/activities'), 'comment');
  assert.equal(
    trafficTriggerFor('GET', '/api/activities?albumId=x&type=comment'),
    undefined,
    'reading is not writing'
  );
  assert.equal(trafficTriggerFor('DELETE', '/api/activities/abc'), undefined, 'a deletion is not a push');
});

test('a sign-in and the session check every client opens with are a session', () => {
  assert.equal(trafficTriggerFor('POST', '/api/auth/login'), 'session');
  assert.equal(trafficTriggerFor('GET', '/api/users/me'), 'session');
});

test('the byte path is never a trigger', () => {
  // This is the one that matters: every photo on screen is a request, and hashing credentials for
  // each of them would put our bookkeeping in the way of the bytes this sidecar exists to stream.
  assert.equal(trafficTriggerFor('GET', '/api/assets/abc/thumbnail'), undefined);
  assert.equal(trafficTriggerFor('GET', '/api/assets/abc/original'), undefined);
  assert.equal(
    trafficTriggerFor('POST', '/api/assets'),
    undefined,
    'an upload alone adds nothing to an album'
  );
  assert.equal(trafficTriggerFor('GET', '/api/timeline/buckets'), undefined);
  assert.equal(trafficTriggerFor('GET', '/api/users/me/preferences'), undefined, 'one marker is enough');
});
