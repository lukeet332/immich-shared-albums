// jpeg_dump.rs — emit the Rust stub JPEGs as hex, for byte-comparison against src/media/jpeg.ts.
// Parity with the TypeScript is the contract: a stub that differs would have different dimensions
// or a different aspect ratio, and Immich lays every shared photo out from it.
fn main() {
    for (w, h) in [
        (4000.0, 3000.0), (3000.0, 4000.0), (1000.0, 1000.0), (4032.0, 3024.0),
        (100.0, 50.0), (7.0, 13.0), (256.0, 256.0), (1.0, 1.0), (8000.0, 6000.0),
        (640.0, 480.0), (1920.0, 1080.0), (1080.0, 1920.0),
    ] {
        let bytes = immich_shared_albums::media::jpeg::jpeg_of_size(w, h);
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        println!("{}x{} {} {}", w as i64, h as i64, bytes.len(), hex);
    }
}
