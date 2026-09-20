/** immich/stand-in-picture.test.ts — whose face an account of ours wears. See local-immich-api.md. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { picturePlanFor } from './stand-in-picture.ts';

// The addon's own picture is a placeholder for the ADDON. A stand-in for a person IS that person in
// Immich's People list, and an album's members are read as people: a robot there says the album is
// shared with a bot when it is shared with your mother.
test('a person who has no avatar of their own is left as Immich draws them, never given our picture', () => {
  assert.equal(
    picturePlanFor({ representsPerson: true, hasPicture: false }),
    'leave',
    'a person without a picture still gets their own initial, which is the point'
  );
});

test("a person's stand-in keeps the avatar synced from their own server", () => {
  assert.equal(
    picturePlanFor({ representsPerson: true, hasPicture: true }),
    'leave',
    'their own face beats anything we would put there'
  );
});

test('our own bot wears our picture', () => {
  assert.equal(picturePlanFor({ representsPerson: false, hasPicture: false }), 'wear');
});

test('our own bot keeps the picture it already has, rather than re-uploading it', () => {
  assert.equal(
    picturePlanFor({ representsPerson: false, hasPicture: true }),
    'leave',
    're-uploading on every pass is a request per account per cycle for a picture that is already right'
  );
});
