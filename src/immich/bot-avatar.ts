/** immich/bot-avatar.ts — the picture our own accounts wear in Immich's People list, drawn here so it ships with the addon and needs no third party. See sync-loops.md. */

import zlib from 'node:zlib';

/** The face: a robot, with the addon's own twist — the link in its chest is a shared album. */
const INK = [15, 23, 42, 255] as const; // eyes, and the line the limbs are drawn in
const FACE = [248, 250, 252, 255] as const; // head, body, limbs
const BACKDROP = [15, 118, 110, 255] as const; // the round behind it all, teal rather than anyone's brand

type Shape = { covers: (x: number, y: number) => boolean; colour: readonly [number, number, number, number] };

const roundRect = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  colour: Shape['colour']
): Shape => ({
  colour,
  covers: (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const nearX = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const nearY = Math.min(Math.max(y, y0 + radius), y1 - radius);
    return (x - nearX) ** 2 + (y - nearY) ** 2 <= radius ** 2;
  },
});

const circle = (cx: number, cy: number, r: number, colour: Shape['colour']): Shape => ({
  colour,
  covers: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r,
});

/** A line with round ends: everything within half its thickness of the segment. */
const limb = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  colour: Shape['colour']
): Shape => {
  const half = thickness / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  return {
    colour,
    covers: (x, y) => {
      const t = Math.min(Math.max(((x - x0) * dx + (y - y0) * dy) / lengthSq, 0), 1);
      return (x - (x0 + t * dx)) ** 2 + (y - (y0 + t * dy)) ** 2 <= half * half;
    },
  };
};

/** The robot, in fractions of the canvas, painted back to front. */
const robot = (size: number): Shape[] => {
  const at = (fraction: number) => fraction * size;
  const head = { x0: at(0.27), y0: at(0.24), x1: at(0.73), y1: at(0.62) };
  const body = { x0: at(0.33), y0: at(0.68), x1: at(0.67), y1: at(0.86) };
  return [
    roundRect(0, 0, size, size, at(0.22), BACKDROP),
    limb(at(0.5), at(0.09), at(0.5), at(0.24), at(0.035), FACE), // antenna
    circle(at(0.5), at(0.075), at(0.045), FACE),
    limb(head.x0 + at(0.02), at(0.7), at(0.16), at(0.83), at(0.05), FACE), // arms
    limb(head.x1 - at(0.02), at(0.7), at(0.84), at(0.83), at(0.05), FACE),
    roundRect(body.x0, body.y0, body.x1, body.y1, at(0.05), FACE), // body
    limb(at(0.42), body.y1 - at(0.01), at(0.42), at(0.95), at(0.05), FACE), // legs
    limb(at(0.58), body.y1 - at(0.01), at(0.58), at(0.95), at(0.05), FACE),
    circle(at(0.44), at(0.77), at(0.055), BACKDROP), // the link in its chest: two rings that overlap
    circle(at(0.56), at(0.77), at(0.055), BACKDROP),
    roundRect(head.x0, head.y0, head.x1, head.y1, at(0.08), FACE), // head last, so it sits on top
    circle(at(0.39), at(0.43), at(0.05), INK), // eyes
    circle(at(0.61), at(0.43), at(0.05), INK),
  ];
};

const SUPER_SAMPLES = 3;

/**
 * The avatar as a PNG, at whatever size is asked for.
 *
 * Drawn by hand and encoded by hand (`node:zlib` for the one compressed chunk) because an avatar is
 * the only image this sidecar has any business shipping: a dependency for it, or a fetched logo,
 * would be more machinery and more trust than a picture of a robot is worth. Edges are supersampled
 * `SUPER_SAMPLES` times, so it does not look ragged beside Immich's own round avatars.
 */
export function botAvatarPng(size = 128): Buffer {
  const shapes = robot(size);
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SUPER_SAMPLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPER_SAMPLES; sy++) {
        for (let sx = 0; sx < SUPER_SAMPLES; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          // Painter's algorithm: the last shape covering this subsample is the one seen.
          let seen: Shape['colour'] | null = null;
          for (const shape of shapes) if (shape.covers(px, py)) seen = shape.colour;
          if (seen) {
            r += seen[0];
            g += seen[1];
            b += seen[2];
            a += seen[3];
          }
        }
      }
      const samples = SUPER_SAMPLES * SUPER_SAMPLES;
      const alpha = a / samples;
      const at = (y * size + x) * 4;
      // Straight (not premultiplied) alpha, averaged over the samples that were painted: a half
      // covered pixel keeps its colour and takes half the opacity, which is what a decoder expects.
      const painted = a / 255 || 1;
      pixels[at] = Math.round(r / painted);
      pixels[at + 1] = Math.round(g / painted);
      pixels[at + 2] = Math.round(b / painted);
      pixels[at + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, size, pixels);
}

const crc32 = (buf: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};

const encodePng = (width: number, height: number, rgba: Buffer): Buffer => {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
