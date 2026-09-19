/** immich/bot-avatar.test.ts — the picture our own accounts wear. See bot-avatar.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { botAvatarPng } from './bot-avatar.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The chunks of a PNG, in order, with their payloads — enough to check what we claim we wrote. */
const chunks = (png: Buffer) => {
  const out: { type: string; data: Buffer }[] = [];
  for (let at = PNG_SIGNATURE.length; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('ascii');
    const data = png.subarray(at + 8, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    const covered = png.subarray(at + 4, at + 8 + length); // the CRC covers the type and the data
    assert.equal(crc, zlib.crc32(covered), 'a wrong CRC makes the chunk unreadable to a strict decoder');
    out.push({ type, data });
    at += 12 + length;
  }
  return out;
};

test('it is a PNG, at the size asked for', () => {
  const png = botAvatarPng(64);
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'a PNG starts with its signature');
  const ihdr = chunks(png).find(c => c.type === 'IHDR');
  assert.ok(ihdr, 'IHDR must be the first chunk');
  assert.equal(ihdr.data.readUInt32BE(0), 64, 'width');
  assert.equal(ihdr.data.readUInt32BE(4), 64, 'height');
  assert.equal(ihdr.data[8], 8, '8 bits per channel');
  assert.equal(ihdr.data[9], 6, 'colour type 6 is RGBA');
});

test('every pixel is accounted for: the scanlines inflate to the size the header claims', () => {
  const size = 48;
  const png = botAvatarPng(size);
  const raw = zlib.inflateSync(chunks(png).find(c => c.type === 'IDAT')!.data);
  assert.equal(raw.length, size * (size * 4 + 1), 'one filter byte plus RGBA per row');
  for (let y = 0; y < size; y++) assert.equal(raw[y * (size * 4 + 1)], 0, `row ${y} uses the None filter`);
});

test('the same request draws the same picture, byte for byte', () => {
  assert.ok(botAvatarPng(32).equals(botAvatarPng(32)), 'an avatar a peer may cache must not change per call');
});

test('it is a picture, not a blank square', () => {
  // A robot: a filled round, a light head and body, dark eyes. Counted rather than eyeballed, so a
  // drawing that silently stops drawing fails here instead of shipping as an empty avatar.
  const size = 64;
  const raw = zlib.inflateSync(chunks(botAvatarPng(size)).find(c => c.type === 'IDAT')!.data);
  const pixel = (x: number, y: number) => [
    ...raw.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 1 + x * 4 + 4),
  ];
  let opaque = 0;
  let light = 0;
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      if (a > 200) opaque++;
      if (a > 200 && r > 200 && g > 200 && b > 200) light++;
      if (a > 200 && r < 80 && g < 80 && b < 80) dark++;
    }
  assert.ok(opaque > size * size * 0.6, `the avatar should mostly be filled, got ${opaque}/${size * size}`);
  assert.ok(light > size * size * 0.1, `the face and body should be light, got ${light}`);
  assert.ok(dark > 20, `there should be eyes and limbs, got ${dark} dark pixels`);
  // The corners are outside the rounded square: an avatar that fills its whole box looks wrong next
  // to Immich's own, which are round.
  assert.equal(pixel(0, 0)[3], 0, 'the top-left corner is transparent');
  assert.equal(pixel(size - 1, 0)[3], 0, 'and the top-right');
});
