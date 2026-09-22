/** media/jpeg.rs — a tiny, dependency-free baseline-JPEG generator for mirror stubs. See PORT.md. */
//
// A mirrored photo is represented locally by a placeholder; the real pixels stream from the owner
// through the byte interceptor. Immich reads the placeholder's DIMENSIONS and lays the photo out
// from them — the grid tile's shape and the viewer's aspect box — so a fixed 1x1 stub makes every
// mirror square in the grid and letterboxed in the viewer. This emits a solid mid-grey JPEG whose
// SOF header declares the photo's real aspect ratio instead.
//
// Deliberately minimal: mid-grey is sample 128, which level-shifts to 0, so every 8x8 block is
// all-zero coefficients and encodes as the SAME six bits — DC category 0 (`00`) then AC
// end-of-block (`1010`) using the standard Annex-K luminance tables. No DCT, no quantiser maths.

/// Long-edge cap for the stub. Small enough to stay ~1KB; the true resolution is never stored here.
pub const MAX_EDGE: u32 = 256;

/// Standard Annex-K luminance Huffman tables. The DC code for symbol 0 is `00` (2 bits) and the AC
/// code for EOB is `1010` (4 bits); both FOLLOW from these tables, so they are emitted verbatim.
const DC_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS: [u8; 162] = [
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

/// Cap dimensions to a small box, preserving aspect ratio. Never upscales.
///
/// Rounding can shift the ratio by a fraction of a pixel — imperceptible in layout. `f64::round`
/// rounds half AWAY FROM ZERO where `Math.round` rounds half UP; both dimensions are positive here,
/// so the two agree.
pub fn bounded_stub_dims(width: f64, height: f64) -> (u32, u32) {
    let w = 1f64.max(width.round()) as u32;
    let h = 1f64.max(height.round()) as u32;
    if w <= MAX_EDGE && h <= MAX_EDGE {
        return (w, h);
    }
    if w >= h {
        (MAX_EDGE, 1u32.max(((h as f64 * MAX_EDGE as f64) / w as f64).round() as u32))
    } else {
        (1u32.max(((w as f64 * MAX_EDGE as f64) / h as f64).round() as u32), MAX_EDGE)
    }
}

fn u16be(n: u32) -> [u8; 2] {
    [((n >> 8) & 0xff) as u8, (n & 0xff) as u8]
}

/// A solid mid-grey baseline JPEG at the given aspect (dimensions capped, see `bounded_stub_dims`).
pub fn jpeg_of_size(width: f64, height: f64) -> Vec<u8> {
    let (w, h) = bounded_stub_dims(width, height);
    let mut out: Vec<u8> = Vec::with_capacity(1024);

    // SOI
    out.extend_from_slice(&[0xff, 0xd8]);
    // APP0 / JFIF
    out.extend_from_slice(&[
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
        0x00, 0x00,
    ]);
    // DQT: a flat table. Every coefficient is zero, so the values are irrelevant; flat is
    // order-agnostic.
    out.extend_from_slice(&[0xff, 0xdb, 0x00, 0x43, 0x00]);
    out.extend_from_slice(&[16u8; 64]);
    // SOF0: 8-bit, one component, no subsampling. HEIGHT comes before WIDTH.
    out.extend_from_slice(&[0xff, 0xc0, 0x00, 0x0b, 0x08]);
    out.extend_from_slice(&u16be(h));
    out.extend_from_slice(&u16be(w));
    out.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
    // DHT: DC table 0 then AC table 0
    let mut dc = vec![0x00u8];
    dc.extend_from_slice(&DC_BITS);
    dc.extend_from_slice(&DC_VALS);
    let mut ac = vec![0x10u8];
    ac.extend_from_slice(&AC_BITS);
    ac.extend_from_slice(&AC_VALS);
    out.extend_from_slice(&[0xff, 0xc4]);
    out.extend_from_slice(&u16be(2 + dc.len() as u32 + ac.len() as u32));
    out.extend_from_slice(&dc);
    out.extend_from_slice(&ac);
    // SOS: one component, DC/AC table 0
    out.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);

    // Entropy-coded scan: one all-zero block per 8x8 MCU, MSB-first, with 0xFF byte stuffing.
    let mut acc: u32 = 0;
    let mut nbits = 0;
    let put_bits = |value: u32, len: u32, out: &mut Vec<u8>, acc: &mut u32, nbits: &mut u32| {
        for i in (0..len).rev() {
            *acc = (*acc << 1) | ((value >> i) & 1);
            *nbits += 1;
            if *nbits == 8 {
                let byte = (*acc & 0xff) as u8;
                out.push(byte);
                if byte == 0xff {
                    out.push(0x00);
                }
                *acc = 0;
                *nbits = 0;
            }
        }
    };
    let blocks = w.div_ceil(8) * h.div_ceil(8);
    for _ in 0..blocks {
        put_bits(0b00, 2, &mut out, &mut acc, &mut nbits); // DC category 0 (diff 0)
        put_bits(0b1010, 4, &mut out, &mut acc, &mut nbits); // AC end-of-block
    }
    if nbits > 0 {
        // Pad the final partial byte with 1-bits, per the JPEG convention.
        let byte = (((acc << (8 - nbits)) | ((1 << (8 - nbits)) - 1)) & 0xff) as u8;
        out.push(byte);
        if byte == 0xff {
            out.push(0x00);
        }
    }

    out.extend_from_slice(&[0xff, 0xd9]); // EOI
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_are_capped_on_the_long_edge_and_never_upscaled() {
        assert_eq!(bounded_stub_dims(4000.0, 3000.0), (256, 192));
        assert_eq!(bounded_stub_dims(3000.0, 4000.0), (192, 256));
        assert_eq!(bounded_stub_dims(1000.0, 1000.0), (256, 256));
        // Already inside the box: untouched, and a small photo is NOT scaled up.
        assert_eq!(bounded_stub_dims(100.0, 50.0), (100, 50));
        assert_eq!(bounded_stub_dims(7.0, 13.0), (7, 13));
        assert_eq!(bounded_stub_dims(256.0, 256.0), (256, 256));
        // A degenerate size is floored at 1 rather than collapsing to zero.
        assert_eq!(bounded_stub_dims(0.0, 0.0), (1, 1));
        assert_eq!(bounded_stub_dims(100000.0, 1.0), (256, 1));
    }

    #[test]
    fn the_markers_are_the_documented_bytes() {
        let jpeg = jpeg_of_size(256.0, 256.0);
        assert_eq!(&jpeg[..2], &[0xff, 0xd8], "SOI");
        assert_eq!(&jpeg[jpeg.len() - 2..], &[0xff, 0xd9], "EOI");
        // APP0/JFIF immediately after SOI.
        assert_eq!(&jpeg[2..6], &[0xff, 0xe0, 0x00, 0x10]);
        assert_eq!(&jpeg[6..12], b"JFIF\0\x01");
    }

    #[test]
    fn sof0_declares_HEIGHT_before_WIDTH_and_the_capped_dims() {
        let jpeg = jpeg_of_size(4000.0, 3000.0);
        let sof = jpeg.windows(2).position(|w| w == [0xff, 0xc0]).expect("SOF0");
        assert_eq!(jpeg[sof + 2], 0x00, "length high byte");
        assert_eq!(jpeg[sof + 3], 0x0b, "length 11");
        assert_eq!(jpeg[sof + 4], 0x08, "8-bit precision");
        // HEIGHT first: 192 = 0x00C0, then WIDTH 256 = 0x0100.
        assert_eq!(&jpeg[sof + 5..sof + 7], &[0x00, 0xc0], "height");
        assert_eq!(&jpeg[sof + 7..sof + 9], &[0x01, 0x00], "width");
        assert_eq!(jpeg[sof + 9], 0x01, "one component");
    }

    #[test]
    fn the_dqt_is_flat_and_the_dht_lengths_are_derived_not_hardcoded() {
        let jpeg = jpeg_of_size(1.0, 1.0);
        let dqt = jpeg.windows(2).position(|w| w == [0xff, 0xdb]).expect("DQT");
        assert_eq!(&jpeg[dqt + 2..dqt + 5], &[0x00, 0x43, 0x00], "length 67, table 0");
        assert!(jpeg[dqt + 5..dqt + 69].iter().all(|b| *b == 16), "flat table");
        let dht = jpeg.windows(2).position(|w| w == [0xff, 0xc4]).expect("DHT");
        // 2 + (1 + 16 + 12) + (1 + 16 + 162)
        let declared = u16::from_be_bytes([jpeg[dht + 2], jpeg[dht + 3]]) as usize;
        assert_eq!(declared, 2 + 29 + 179);
        assert_eq!(jpeg[dht + 4], 0x00, "DC table 0");
        assert_eq!(jpeg[dht + 4 + 1 + 16 + 12], 0x10, "AC table 0 follows the DC table");
    }

    #[test]
    fn a_stub_stays_around_a_kilobyte_whatever_the_original_size() {
        // The point is the RATIO, not the resolution: a 48MP photo and a 0.3MP one both stub small.
        for (w, h) in [(4000.0, 3000.0), (4032.0, 3024.0), (8000.0, 6000.0), (640.0, 480.0)] {
            let jpeg = jpeg_of_size(w, h);
            assert!(jpeg.len() < 4096, "{w}x{h} produced {} bytes", jpeg.len());
            assert!(jpeg.len() > 300, "{w}x{h} produced {} bytes", jpeg.len());
        }
    }

    #[test]
    fn the_aspect_ratio_survives_the_cap() {
        for (w, h) in [(4000.0, 3000.0), (3000.0, 4000.0), (1000.0, 1000.0), (4032.0, 3024.0), (100.0, 50.0), (7.0, 13.0)] {
            let (bw, bh) = bounded_stub_dims(w, h);
            let want = w / h;
            let got = bw as f64 / bh as f64;
            assert!(
                (got - want).abs() / want < 0.02,
                "{w}x{h} -> {bw}x{bh} shifts the ratio from {want} to {got}"
            );
        }
    }

    #[test]
    fn an_all_zero_scan_needs_no_ff_stuffing() {
        // Mid-grey is sample 128, which level-shifts to 0, so the six bits per block are the SAME
        // everywhere and never produce 0xFF. Asserting it here means a future change that starts
        // emitting real coefficients is noticed rather than silently corrupting the scan.
        let jpeg = jpeg_of_size(64.0, 64.0);
        let sos = jpeg.windows(2).position(|w| w == [0xff, 0xda]).expect("SOS");
        // SOS is `FF DA` + a 2-byte length + 6 bytes of payload = 10 bytes, then the scan begins.
        assert_eq!(&jpeg[sos..sos + 4], &[0xff, 0xda, 0x00, 0x08]);
        let scan = &jpeg[sos + 10..jpeg.len() - 2];
        assert!(scan.iter().all(|b| *b != 0xff), "no stuffing is needed for a flat scan");
        // 8x8 blocks of 8x8 pixels, six bits each, and 384 bits divides exactly into 48 bytes.
        assert_eq!(scan.len(), (64 / 8) * (64 / 8) * 6 / 8, "6 bits per block");
    }
}
