//! immich/bot_avatar.rs — the picture our own accounts wear in Immich's People list, drawn here so it ships with the addon and needs no third party. See ARCHITECTURE.md.

/// The face: a robot, with the addon's own twist — the link in its chest is a shared album.
const INK: [u8; 4] = [15, 23, 42, 255]; // eyes, and the line the limbs are drawn in
const FACE: [u8; 4] = [248, 250, 252, 255]; // head, body, limbs
const BACKDROP: [u8; 4] = [15, 118, 110, 255]; // the round behind it all, teal rather than anyone's brand

const SUPER_SAMPLES: u32 = 3;

struct Shape {
    colour: [u8; 4],
    covers: Box<dyn Fn(f64, f64) -> bool>,
}

fn round_rect(x0: f64, y0: f64, x1: f64, y1: f64, radius: f64, colour: [u8; 4]) -> Shape {
    Shape {
        colour,
        covers: Box::new(move |x, y| {
            if x < x0 || x > x1 || y < y0 || y > y1 {
                return false;
            }
            let near_x = (x0 + radius).max(x.min(x1 - radius));
            let near_y = (y0 + radius).max(y.min(y1 - radius));
            (x - near_x).powi(2) + (y - near_y).powi(2) <= radius * radius
        }),
    }
}

fn circle(cx: f64, cy: f64, r: f64, colour: [u8; 4]) -> Shape {
    Shape { colour, covers: Box::new(move |x, y| (x - cx).powi(2) + (y - cy).powi(2) <= r * r) }
}

/// A line with round ends: everything within half its thickness of the segment.
fn limb(
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    thickness: f64,
    colour: [u8; 4],
) -> Shape {
    let half = thickness / 2.0;
    let dx = x1 - x0;
    let dy = y1 - y0;
    let length_sq = dx * dx + dy * dy;
    Shape {
        colour,
        covers: Box::new(move |x, y| {
            let t = (((x - x0) * dx + (y - y0) * dy) / length_sq).clamp(0.0, 1.0);
            (x - (x0 + t * dx)).powi(2) + (y - (y0 + t * dy)).powi(2) <= half * half
        }),
    }
}

/// The robot, in fractions of the canvas, painted back to front.
fn robot(size: f64) -> Vec<Shape> {
    let at = |fraction: f64| fraction * size;
    let head = (at(0.27), at(0.24), at(0.73), at(0.62));
    let body = (at(0.33), at(0.68), at(0.67), at(0.86));
    vec![
        round_rect(0.0, 0.0, size, size, at(0.22), BACKDROP),
        limb(at(0.5), at(0.09), at(0.5), at(0.24), at(0.035), FACE), // antenna
        circle(at(0.5), at(0.075), at(0.045), FACE),
        limb(head.0 + at(0.02), at(0.7), at(0.16), at(0.83), at(0.05), FACE), // arms
        limb(head.2 - at(0.02), at(0.7), at(0.84), at(0.83), at(0.05), FACE),
        round_rect(body.0, body.1, body.2, body.3, at(0.05), FACE), // body
        limb(at(0.42), body.3 - at(0.01), at(0.42), at(0.95), at(0.05), FACE), // legs
        limb(at(0.58), body.3 - at(0.01), at(0.58), at(0.95), at(0.05), FACE),
        circle(at(0.44), at(0.77), at(0.055), BACKDROP), // the link in its chest: two rings that overlap
        circle(at(0.56), at(0.77), at(0.055), BACKDROP),
        round_rect(head.0, head.1, head.2, head.3, at(0.08), FACE), // head last, so it sits on top
        circle(at(0.39), at(0.43), at(0.05), INK), // eyes
        circle(at(0.61), at(0.43), at(0.05), INK),
    ]
}

/// The avatar as a PNG, at whatever size is asked for.
///
/// Drawn by hand and encoded by hand — an avatar is the only image this sidecar has any business
/// shipping, and a dependency for it would be more machinery than a picture of a robot is worth.
/// Edges are supersampled `SUPER_SAMPLES` times, so it does not look ragged beside Immich's own
/// round avatars.
pub fn bot_avatar_png(size: u32) -> Vec<u8> {
    let shapes = robot(size as f64);
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let step = 1.0 / SUPER_SAMPLES as f64;
    for y in 0..size {
        for x in 0..size {
            let (mut r, mut g, mut b, mut a) = (0f64, 0f64, 0f64, 0f64);
            for sy in 0..SUPER_SAMPLES {
                for sx in 0..SUPER_SAMPLES {
                    let px = x as f64 + (sx as f64 + 0.5) * step;
                    let py = y as f64 + (sy as f64 + 0.5) * step;
                    // Painter's algorithm: the last shape covering this subsample is the one seen.
                    let mut seen: Option<[u8; 4]> = None;
                    for shape in &shapes {
                        if (shape.covers)(px, py) {
                            seen = Some(shape.colour);
                        }
                    }
                    if let Some(colour) = seen {
                        r += colour[0] as f64;
                        g += colour[1] as f64;
                        b += colour[2] as f64;
                        a += colour[3] as f64;
                    }
                }
            }
            let samples = (SUPER_SAMPLES * SUPER_SAMPLES) as f64;
            let alpha = a / samples;
            let at = ((y * size + x) * 4) as usize;
            // Straight (not premultiplied) alpha, averaged over the samples that were painted: a half
            // covered pixel keeps its colour and takes half the opacity, which is what a decoder
            // expects.
            let painted = if a / 255.0 == 0.0 { 1.0 } else { a / 255.0 };
            pixels[at] = (r / painted).round() as u8;
            pixels[at + 1] = (g / painted).round() as u8;
            pixels[at + 2] = (b / painted).round() as u8;
            pixels[at + 3] = alpha.round() as u8;
        }
    }
    encode_png(size, size, &pixels)
}

fn crc32(buf: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in buf {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    crc ^ 0xffff_ffff
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(4 + data.len());
    body.extend_from_slice(kind);
    body.extend_from_slice(data);
    let mut out = Vec::with_capacity(4 + body.len() + 4);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write as _;

    let stride = (width * 4) as usize;
    let mut raw = vec![0u8; height as usize * (stride + 1)];
    for y in 0..height as usize {
        raw[y * (stride + 1)] = 0; // filter type None
        raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)].copy_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    let compressed = match encoder.write_all(&raw).and_then(|_| encoder.finish()) {
        Ok(bytes) => bytes,
        Err(_) => Vec::new(),
    };
    let mut header = [0u8; 13];
    header[0..4].copy_from_slice(&width.to_be_bytes());
    header[4..8].copy_from_slice(&height.to_be_bytes());
    header[8] = 8; // bits per channel
    header[9] = 6; // colour type: RGBA
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend_from_slice(&chunk(b"IHDR", &header));
    out.extend_from_slice(&chunk(b"IDAT", &compressed));
    out.extend_from_slice(&chunk(b"IEND", &[]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_avatar_is_a_png_of_the_size_asked_for() {
        let png = bot_avatar_png(128);
        assert_eq!(&png[0..8], &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG magic");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes([png[16], png[17], png[18], png[19]]), 128);
        assert_eq!(u32::from_be_bytes([png[20], png[21], png[22], png[23]]), 128);
        assert_eq!(png[24], 8, "bits per channel");
        assert_eq!(png[25], 6, "colour type RGBA");
        assert!(png.windows(4).any(|w| w == b"IEND"), "the stream is terminated");
    }

    #[test]
    fn the_picture_is_opaque_in_the_middle_and_clear_at_the_corner() {
        // A shape that covered nothing would still encode; this pins that something was painted, and
        // that the rounded backdrop leaves the corners transparent as a round avatar needs.
        let png = bot_avatar_png(32);
        assert!(png.len() > 200, "a drawn picture is more than a header");
        let pixels = decode_rgba_for_test(&png, 32);
        let corner = &pixels[0..4];
        let middle_at = (16 * 32 + 16) * 4;
        let middle = &pixels[middle_at..middle_at + 4];
        assert_eq!(corner[3], 0, "the corner is outside the round backdrop");
        assert_eq!(middle[3], 255, "the middle is fully painted");
    }

    /// Minimal PNG reader: enough to undo what `encode_png` wrote, so the test asserts on pixels
    /// rather than on the bytes of one particular deflate implementation.
    fn decode_rgba_for_test(png: &[u8], size: usize) -> Vec<u8> {
        use flate2::read::ZlibDecoder;
        use std::io::Read as _;

        let mut at = 8usize;
        let mut idat = Vec::new();
        while at + 8 <= png.len() {
            let length = u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]) as usize;
            let kind = &png[at + 4..at + 8];
            if kind == b"IDAT" {
                idat.extend_from_slice(&png[at + 8..at + 8 + length]);
            }
            at += 12 + length;
        }
        let mut raw = Vec::new();
        ZlibDecoder::new(&idat[..]).read_to_end(&mut raw).expect("zlib stream");
        let stride = size * 4;
        let mut out = vec![0u8; size * stride];
        for y in 0..size {
            assert_eq!(raw[y * (stride + 1)], 0, "filter type None");
            out[y * stride..(y + 1) * stride]
                .copy_from_slice(&raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)]);
        }
        out
    }
}
