/**
 * media/jpeg.ts — a tiny, dependency-free baseline-JPEG generator for mirror stubs.
 *
 * A mirrored photo is represented locally by a placeholder asset; the real pixels stream from the
 * owner via the byte interceptor. Immich reads the placeholder's pixel dimensions and lays the photo
 * out from them — the grid tile's shape and the viewer's aspect box. A fixed 1×1 stub therefore
 * makes every mirror square in the grid and letterboxed in the viewer. `jpegOfSize` instead emits a
 * solid mid-grey JPEG whose SOF header declares the photo's real ASPECT RATIO, so Immich lays it out
 * correctly. (The interceptor still serves the true full-resolution bytes on view.)
 *
 * Deliberately minimal: mid-grey is sample 128, which level-shifts to 0, so every 8×8 block is
 * all-zero coefficients and encodes as the SAME six bits — DC category 0 (`00`) then AC end-of-block
 * (`1010`) using the standard Annex-K luminance Huffman tables. No DCT, no quantiser maths. The
 * requested dimensions are capped to a small box (long edge ≤ MAX_EDGE) preserving aspect, so a stub
 * stays ~1KB regardless of the original's size: the point is the ratio, not the resolution.
 */

// Long-edge cap for the stub. Small enough to stay ~1KB; the true resolution is never stored here.
const MAX_EDGE = 256;

// Standard Annex-K luminance Huffman tables (BITS = code counts by length 1..16; VALS = symbols).
// The DC code for symbol 0 is "00" (2 bits) and the AC code for symbol 0 (EOB) is "1010" (4 bits);
// both follow from these tables, so they must be emitted verbatim.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
// prettier-ignore
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/**
 * Cap dimensions to a small box, preserving aspect ratio. Never upscales. Rounding can shift the
 * ratio by a fraction of a pixel — imperceptible in layout.
 */
export function boundedStubDims(width: number, height: number): [number, number] {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w <= MAX_EDGE && h <= MAX_EDGE) return [w, h];
  return w >= h
    ? [MAX_EDGE, Math.max(1, Math.round((h * MAX_EDGE) / w))]
    : [Math.max(1, Math.round((w * MAX_EDGE) / h)), MAX_EDGE];
}

/** A solid mid-grey baseline JPEG at the given aspect (dimensions capped, see boundedStubDims). */
export function jpegOfSize(width: number, height: number): Buffer {
  const [w, h] = boundedStubDims(width, height);
  const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
  const out: number[] = [];

  out.push(0xff, 0xd8); // SOI
  // APP0 / JFIF
  out.push(
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00
  );
  // DQT: a flat table (every coefficient is zero, so the values are irrelevant; flat = order-agnostic)
  out.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(16));
  // SOF0: 8-bit, one component, no subsampling
  out.push(0xff, 0xc0, 0x00, 0x0b, 0x08, ...u16(h), ...u16(w), 0x01, 0x01, 0x11, 0x00);
  // DHT: DC table 0 + AC table 0
  const dc = [0x00, ...DC_BITS, ...DC_VALS];
  const ac = [0x10, ...AC_BITS, ...AC_VALS];
  out.push(0xff, 0xc4, ...u16(2 + dc.length + ac.length), ...dc, ...ac);
  // SOS: one component, DC/AC table 0
  out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);

  // Entropy-coded scan: one all-zero block per 8×8 MCU. MSB-first, with 0xFF byte-stuffing.
  let acc = 0;
  let nbits = 0;
  const putBits = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++nbits === 8) {
        out.push(acc & 0xff);
        if ((acc & 0xff) === 0xff) out.push(0x00);
        acc = 0;
        nbits = 0;
      }
    }
  };
  const blocks = Math.ceil(w / 8) * Math.ceil(h / 8);
  for (let i = 0; i < blocks; i++) {
    putBits(0b00, 2); // DC category 0 (diff 0)
    putBits(0b1010, 4); // AC end-of-block
  }
  if (nbits > 0) {
    // pad the final partial byte with 1-bits, per the JPEG convention
    const b = ((acc << (8 - nbits)) | ((1 << (8 - nbits)) - 1)) & 0xff;
    out.push(b);
    if (b === 0xff) out.push(0x00);
  }

  out.push(0xff, 0xd9); // EOI
  return Buffer.from(out);
}
