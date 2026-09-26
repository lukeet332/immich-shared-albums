/** p2p/frame.rs — the isa/2 frame codec: two u32-LE length prefixes per request. See ARCHITECTURE.md. */
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};

/// The request header frame is capped at a fixed 64 KiB — it is a path and a range, and nothing
/// legitimate comes close.
pub const HEADER_FRAME_LIMIT: usize = 64 * 1024;

/// A hostile declaration costs at most this much reading before the connection goes.
pub const DRAIN_MAX: usize = 64 * 1024 * 1024;

/// Drain and stream reads go in chunks no larger than this.
pub const READ_CHUNK: usize = 256 * 1024;

/// The JSON body a dialled request may return. A byte body has no such cap: it streams to FIN.
pub const JSON_BODY_LIMIT: usize = 64 * 1024 * 1024;

/// One frame: a u32 little-endian length, then exactly that many bytes. There is no presence flag,
/// so a zero-length frame is four zero bytes and a bodyless request still sends one.
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// A frame that was too large to accept. The stream has already been drained when this is returned,
/// so the caller can answer safely.
#[derive(Debug, PartialEq, Eq)]
pub struct OverLimit {
    pub declared: usize,
}

/// Read a length-prefixed frame, or CONSUME an over-limit one and report it.
///
/// The stream must be fully drained before we answer: tearing down a half-read stream has killed
/// the whole process inside the native layer. The drain is capped, so a hostile multi-gigabyte
/// declaration costs the capped read and then the connection.
pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Result<Vec<u8>, OverLimit>> {
    let mut len_bytes = [0u8; 4];
    reader.read_exact(&mut len_bytes).await?;
    let declared = u32::from_le_bytes(len_bytes) as usize;
    if declared <= limit {
        if declared == 0 {
            return Ok(Ok(Vec::new()));
        }
        let mut buf = vec![0u8; declared];
        reader.read_exact(&mut buf).await?;
        return Ok(Ok(buf));
    }

    let mut left = declared.min(DRAIN_MAX);
    let mut scratch = vec![0u8; READ_CHUNK.min(left.max(1))];
    while left > 0 {
        let want = left.min(READ_CHUNK);
        match reader.read(&mut scratch[..want]).await {
            // The sender reset their side — equally fully closed, which is all the drain is for.
            Err(_) => break,
            Ok(0) => break,
            Ok(n) => left -= n,
        }
    }
    Ok(Err(OverLimit { declared }))
}

/// A dialled request's header. `range` is a single HTTP byte-range forwarded verbatim, and
/// `mapping` is ADVISORY in protocol 2 — senders include it, receivers ignore it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RequestHeader {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mapping: Option<String>,
}

/// A response's header. `headers` is omitted entirely when there are none, and keys are lowercase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseHeader {
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

impl ResponseHeader {
    pub fn new(status: u16) -> Self {
        ResponseHeader {
            status,
            headers: None,
        }
    }

    /// The JSON routes answer with exactly this content type.
    pub fn json(status: u16) -> Self {
        let mut headers = std::collections::HashMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        ResponseHeader {
            status,
            headers: Some(headers),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_all(bytes: &[u8], limit: usize) -> Result<Vec<u8>, OverLimit> {
        let mut cursor = bytes;
        read_frame(&mut cursor, limit).await.unwrap()
    }

    #[test]
    fn a_frame_is_a_little_endian_u32_then_the_payload() {
        let f = frame(b"{\"path\":\"/hello\"}");
        assert_eq!(&f[..4], &[17, 0, 0, 0], "17-byte payload, u32-LE");
        assert_eq!(&f[4..], b"{\"path\":\"/hello\"}");
    }

    #[test]
    fn a_bodyless_request_still_sends_a_four_byte_zero() {
        // There is no presence flag: the receiver reads a length and then that many bytes.
        assert_eq!(frame(&[]), vec![0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn a_zero_length_frame_reads_back_empty_not_as_an_error() {
        let got = read_all(&frame(&[]), 1024).await.unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn a_round_trip_preserves_the_exact_bytes() {
        let payload = vec![0u8, 255, 1, 254, 0, 0, 7];
        let got = read_all(&frame(&payload), 1024).await.unwrap();
        assert_eq!(got, payload);
    }

    #[tokio::test]
    async fn an_over_limit_frame_is_drained_and_reported_with_its_declared_size() {
        // A hostile length must not leave a half-read stream behind, and must not be believed.
        let mut wire = frame(&vec![0xAB; 5000]);
        wire.extend_from_slice(&frame(b"next"));
        let mut cursor = &wire[..];
        let got = read_frame(&mut cursor, 1024).await.unwrap();
        assert_eq!(got, Err(OverLimit { declared: 5000 }));
        // The drain consumed exactly the declared frame, so the NEXT frame is still readable.
        let next = read_frame(&mut cursor, 1024).await.unwrap().unwrap();
        assert_eq!(next, b"next");
    }

    #[tokio::test]
    async fn the_drain_is_capped_so_a_hostile_declaration_cannot_cost_unbounded_reads() {
        // Declare 4 GiB, supply a little: the drain stops at end-of-input rather than spinning.
        let mut wire = u32::MAX.to_le_bytes().to_vec();
        wire.extend_from_slice(&[0u8; 64]);
        let got = read_all(&wire, 1024).await;
        assert_eq!(
            got,
            Err(OverLimit {
                declared: u32::MAX as usize
            })
        );
    }

    #[tokio::test]
    async fn the_header_limit_is_a_fixed_64k() {
        assert_eq!(HEADER_FRAME_LIMIT, 64 * 1024);
        // A header just under the limit is accepted; one over is not.
        let under = vec![b'x'; HEADER_FRAME_LIMIT];
        assert!(read_all(&frame(&under), HEADER_FRAME_LIMIT).await.is_ok());
        let over = vec![b'x'; HEADER_FRAME_LIMIT + 1];
        assert!(read_all(&frame(&over), HEADER_FRAME_LIMIT).await.is_err());
    }

    #[test]
    fn a_request_header_omits_absent_optional_fields() {
        // The TypeScript sends `JSON.stringify({path, range})`, where an absent range disappears.
        let bare = serde_json::to_string(&RequestHeader {
            path: "/hello".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(bare, "{\"path\":\"/hello\"}");
        let with_range = serde_json::to_string(&RequestHeader {
            path: "/assets/a1/playback".into(),
            range: Some("bytes=0-2097151".into()),
            mapping: None,
        })
        .unwrap();
        assert_eq!(
            with_range,
            "{\"path\":\"/assets/a1/playback\",\"range\":\"bytes=0-2097151\"}"
        );
    }

    #[test]
    fn a_json_response_header_carries_the_lowercase_content_type() {
        let h = ResponseHeader::json(200);
        assert_eq!(
            h.headers.as_ref().unwrap().get("content-type").unwrap(),
            "application/json"
        );
        // A byte route forwards exactly these four, and nothing else.
        assert_eq!(h.status, 200);
    }

    #[test]
    fn a_response_header_without_headers_omits_the_key_entirely() {
        let bare = serde_json::to_string(&ResponseHeader::new(431)).unwrap();
        assert_eq!(bare, "{\"status\":431}");
    }

    #[test]
    fn request_headers_parse_from_the_shape_the_oracle_sends() {
        // Exactly what demo/e2e/iroh-client.mjs writes: JSON.stringify({path, range}).
        let parsed: RequestHeader =
            serde_json::from_str("{\"path\":\"/hello\",\"range\":null}").unwrap();
        assert_eq!(parsed.path, "/hello");
        assert_eq!(parsed.range, None);
        let parsed: RequestHeader =
            serde_json::from_str("{\"path\":\"/assets/x/preview\"}").unwrap();
        assert_eq!(parsed.path, "/assets/x/preview");
    }

    #[test]
    fn response_headers_parse_from_the_shape_the_oracle_expects() {
        let parsed: ResponseHeader =
            serde_json::from_str("{\"status\":200,\"headers\":{\"content-type\":\"image/jpeg\"}}")
                .unwrap();
        assert_eq!(parsed.status, 200);
        assert_eq!(
            parsed.headers.unwrap().get("content-type").unwrap(),
            "image/jpeg"
        );
    }
}
