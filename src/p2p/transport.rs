/** p2p/transport.rs — the iroh peer transport: endpoint lifecycle, dial-by-key, request framing. See ARCHITECTURE.md. */
use crate::config::cfg;
use crate::p2p::frame::{
    frame, read_frame, RequestHeader, ResponseHeader, HEADER_FRAME_LIMIT, JSON_BODY_LIMIT,
};
use crate::store::Peer;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMode, SecretKey};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Reject a hung request instead of blocking a sync loop forever.
pub const DEADLINE: Duration = Duration::from_secs(120);
/// Reaching a peer is a different budget from streaming a body: a dial either completes in a few
/// seconds (direct, hole-punched, or via the relay) or the peer is not there.
pub const DIAL_DEADLINE: Duration = Duration::from_secs(10);
/// The byte path's response HEADER. Bodies keep DEADLINE semantics — they stream to FIN.
pub const BYTE_HEAD_DEADLINE: Duration = Duration::from_secs(15);
/// The most a peer may answer a byte request with. Our own photos are bounded by the library, but a
/// PEER is not us: without this, a misbehaving or hostile one answers a thumbnail request with an
/// endless stream and the sidecar buffers it until the kernel kills the process.
pub const BYTE_BODY_LIMIT: usize = 64 * 1024 * 1024;

/// ALPN for protocol 2, and the only one this build serves.
pub const PROTOCOL_ALPN: &[u8] = crate::protocol::PROTOCOL_ALPN;

/// A stream of body chunks. A byte route can legitimately carry a 4K original, so the body is
/// streamed rather than buffered: a `Vec<u8>` body would hold the whole photo in memory, twice.
pub type ByteStream = std::pin::Pin<Box<dyn futures_lite::Stream<Item = Vec<u8>> + Send>>;

/// What a peer route answers: a status, optional headers, and a body that is either small and
/// already in hand or a stream that has not been read yet.
pub enum PeerBody {
    Bytes(Vec<u8>),
    Stream(ByteStream),
}

impl PeerBody {
    pub fn bytes(body: Vec<u8>) -> Self {
        PeerBody::Bytes(body)
    }
}

pub struct PeerAnswer {
    pub status: u16,
    pub headers: Option<HashMap<String, String>>,
    pub body: PeerBody,
}

pub type PeerHandler = Arc<
    dyn Fn(String, RequestHeader, Vec<u8>) -> futures_lite::future::Boxed<PeerAnswer> + Send + Sync,
>;

pub struct Transport {
    endpoint: Endpoint,
    /// One live connection per peer key. A connection whose peer restarted still LOOKS open to
    /// QUIC for ~45 s, so reuse is gated on `close_reason()` being `None` — and every wait that can
    /// span a restart additionally races `closed()`, because that is the only signal that fires.
    connections: Mutex<HashMap<String, iroh::endpoint::Connection>>,
}

static TRANSPORT: std::sync::OnceLock<Arc<Transport>> = std::sync::OnceLock::new();

impl Transport {
    /// Bind the endpoint and start accepting. The endpoint binds a STABLE UDP port because a peer
    /// remembers where it last reached us, and only a fixed port keeps that memory true across a
    /// restart — a random one leaves recovery to whether we happen to dial the peer first.
    pub async fn start(handler: PeerHandler) -> Result<Arc<Transport>, String> {
        let secret = secret_key()?;
        let mut builder = Endpoint::builder(presets::Minimal).secret_key(secret);
        if cfg().p2p_port != 0 {
            builder = builder
                .bind_addr(format!("0.0.0.0:{}", cfg().p2p_port))
                .map_err(|e| format!("cannot bind UDP {}: {e}", cfg().p2p_port))?;
        }
        // Relays assist hole-punching and carry end-to-end-encrypted traffic when a direct path
        // fails — the one disclosed third party, and only ever a fallback. ISA_RELAY=false runs dark.
        builder = builder.relay_mode(if cfg().relay {
            RelayMode::Default
        } else {
            RelayMode::Disabled
        });
        builder = builder.alpns(crate::protocol::served_alpns());

        let endpoint = builder
            .bind()
            .await
            .map_err(|e| format!("cannot bind endpoint: {e}"))?;
        let transport = Arc::new(Transport {
            endpoint,
            connections: Mutex::new(HashMap::new()),
        });

        let accepting = transport.clone();
        tokio::spawn(async move { accept_loop(accepting, handler).await });
        Ok(transport)
    }

    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// The identity string peers see: raw 32 bytes, base64url — byte-for-byte the endpoint id.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.endpoint.id().as_bytes())
    }

    /// Where to reach us right now. The share page and every pairing ticket carry this.
    pub fn local_addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// The direct addresses a peer could try, as `ip:port` strings.
    pub fn direct_addresses(&self) -> Vec<String> {
        self.endpoint
            .addr()
            .ip_addrs()
            .map(|a| a.to_string())
            .collect::<Vec<_>>()
    }

    pub fn relay_url(&self) -> Option<String> {
        self.endpoint
            .addr()
            .relay_urls()
            .next()
            .map(|u| u.to_string())
    }

    /// A connection to a peer, reusing a live one when there is one.
    pub async fn connection_for(&self, peer: &Peer) -> Result<iroh::endpoint::Connection, String> {
        if let Some(live) = self.cached_live(&peer.pub_key) {
            return Ok(live);
        }
        let id = endpoint_id(&peer.pub_key)?;
        let mut addr = EndpointAddr::new(id);
        if let Some(relay) = &peer.relay_hint {
            if let Ok(url) = relay.parse() {
                addr = addr.with_relay_url(url);
            }
        }
        if let Some(addrs) = &peer.last_addrs {
            let parsed: Vec<iroh::TransportAddr> = addrs
                .iter()
                .filter_map(|a| a.parse::<std::net::SocketAddr>().ok())
                .map(iroh::TransportAddr::Ip)
                .collect();
            if !parsed.is_empty() {
                addr = addr.with_addrs(parsed);
            }
        }
        let dialled =
            tokio::time::timeout(DIAL_DEADLINE, self.endpoint.connect(addr, PROTOCOL_ALPN))
                .await
                .map_err(|_| {
                    format!(
                        "dialling {} timed out after {}s",
                        peer.name,
                        DIAL_DEADLINE.as_secs()
                    )
                })?
                .map_err(|e| format!("dialling {} failed: {e}", peer.name))?;
        self.connections
            .lock()
            .unwrap()
            .insert(peer.pub_key.clone(), dialled.clone());
        Ok(dialled)
    }

    fn cached_live(&self, pub_key: &str) -> Option<iroh::endpoint::Connection> {
        let conn = self.connections.lock().unwrap().get(pub_key).cloned()?;
        // `close_reason()` is NOT a liveness test on its own — it stays None for a peer that is
        // already gone — but a Some(_) is conclusive, so it is the right reuse gate.
        if conn.close_reason().is_none() {
            Some(conn)
        } else {
            self.connections.lock().unwrap().remove(pub_key);
            None
        }
    }

    fn evict(&self, pub_key: &str) {
        self.connections.lock().unwrap().remove(pub_key);
    }

    /// One JSON round trip: dial, send the header and body frames, read the response header, then
    /// read the JSON body to FIN.
    pub async fn round_trip(
        &self,
        peer: &Peer,
        header: &RequestHeader,
        body: Option<&[u8]>,
    ) -> Result<(ResponseHeader, Vec<u8>), String> {
        let conn = self.connection_for(peer).await?;
        let result = tokio::time::timeout(DEADLINE, self.exchange_json(&conn, header, body))
            .await
            .map_err(|_| format!("{} timed out after {}s", header.path, DEADLINE.as_secs()))?;
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                // A failed exchange may have been a dead connection: evict so the next call dials.
                if is_connection_death(&e) {
                    self.evict(&peer.pub_key);
                }
                Err(e)
            }
        }
    }

    async fn exchange_json(
        &self,
        conn: &iroh::endpoint::Connection,
        header: &RequestHeader,
        body: Option<&[u8]>,
    ) -> Result<(ResponseHeader, Vec<u8>), String> {
        // Every await that can span a restart races the connection dying — `closed()` is the only
        // signal that fires for an already-gone peer.
        tokio::select! {
            biased;
            reason = conn.closed() => Err(format!("connection closed before {}: {reason}", header.path)),
            result = self.exchange_inner(conn, header, body) => result,
        }
    }

    async fn exchange_inner(
        &self,
        conn: &iroh::endpoint::Connection,
        header: &RequestHeader,
        body: Option<&[u8]>,
    ) -> Result<(ResponseHeader, Vec<u8>), String> {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        let header_json = serde_json::to_vec(header).map_err(|e| e.to_string())?;
        send.write_all(&frame(&header_json))
            .await
            .map_err(|e| e.to_string())?;
        // A bodyless request still sends a four-byte zero: the frame has no presence flag.
        send.write_all(&frame(body.unwrap_or(&[])))
            .await
            .map_err(|e| e.to_string())?;
        send.finish().map_err(|e| e.to_string())?;

        let head_bytes = read_frame(&mut recv, HEADER_FRAME_LIMIT)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|over| {
                format!(
                    "response header frame of {} bytes is over the limit",
                    over.declared
                )
            })?;
        let head: ResponseHeader =
            serde_json::from_slice(&head_bytes).map_err(|e| format!("bad response header: {e}"))?;

        let mut rest = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        // iroh's read() answers Option<usize>: None is FIN, which is a normal end rather than an error.
        while let Some(n) = recv.read(&mut chunk).await.map_err(|e| e.to_string())? {
            rest.extend_from_slice(&chunk[..n]);
            if rest.len() > JSON_BODY_LIMIT {
                return Err("response body exceeded the JSON limit".to_string());
            }
        }
        Ok((head, rest))
    }

    /// One BYTE round trip, with the same rule the JSON path gets from `round_trip`: a failed
    /// exchange EVICTS the connection, because a timed-out or broken one must not be reused.
    ///
    /// This is not tidiness. A cached QUIC connection to a peer that died without closing still
    /// reads as open (`close_reason()` is None), so reusing it fails until QUIC's own loss detection
    /// notices — about 45 s. Without the eviction, a member's uncached photos keep answering from
    /// the local stub for that whole window AFTER the owner is back, which is exactly what the
    /// suite's hotlink-recovery check measures.
    pub async fn byte_request(
        &self,
        peer: &Peer,
        path: &str,
        range: Option<&str>,
        mapping: Option<&str>,
    ) -> Result<(ResponseHeader, Vec<u8>), String> {
        let outcome = self.byte_request_on(peer, path, range, mapping).await;
        if outcome.is_err() {
            self.evict(&peer.pub_key);
        }
        outcome
    }

    /// The header has a shorter deadline, and the body streams to FIN with none at all — a 4K
    /// original may legitimately take minutes.
    async fn byte_request_on(
        &self,
        peer: &Peer,
        path: &str,
        range: Option<&str>,
        mapping: Option<&str>,
    ) -> Result<(ResponseHeader, Vec<u8>), String> {
        let conn = self.connection_for(peer).await?;
        let header = RequestHeader {
            path: path.to_string(),
            range: range.map(|r| r.to_string()),
            mapping: mapping.map(|m| m.to_string()),
        };
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        let header_json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
        send.write_all(&frame(&header_json))
            .await
            .map_err(|e| e.to_string())?;
        send.write_all(&frame(&[]))
            .await
            .map_err(|e| e.to_string())?;
        send.finish().map_err(|e| e.to_string())?;

        let head_bytes = tokio::time::timeout(
            BYTE_HEAD_DEADLINE,
            read_frame(&mut recv, HEADER_FRAME_LIMIT),
        )
        .await
        .map_err(|_| {
            format!(
                "{path} byte header timed out after {}s",
                BYTE_HEAD_DEADLINE.as_secs()
            )
        })?
        .map_err(|e| e.to_string())?
        .map_err(|over| {
            format!(
                "byte header frame of {} bytes is over the limit",
                over.declared
            )
        })?;
        let head: ResponseHeader =
            serde_json::from_slice(&head_bytes).map_err(|e| format!("bad byte header: {e}"))?;

        let mut body = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        while let Some(n) = recv.read(&mut chunk).await.map_err(|e| e.to_string())? {
            if body.len() + n > BYTE_BODY_LIMIT {
                return Err(format!(
                    "{path}: response body from \"{}\" exceeded {} bytes",
                    peer.name, BYTE_BODY_LIMIT
                ));
            }
            body.extend_from_slice(&chunk[..n]);
        }
        Ok((head, body))
    }
}

async fn accept_loop(transport: Arc<Transport>, handler: PeerHandler) {
    while let Some(incoming) = transport.endpoint.accept().await {
        let handler = handler.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(e) => {
                    crate::log!("incoming connection failed: {e}");
                    return;
                }
            };
            // The PROVEN identity, never a header: the connection is the credential.
            let caller = URL_SAFE_NO_PAD.encode(conn.remote_id().as_bytes());
            serve_connection(conn, caller, handler).await;
        });
    }
}

async fn serve_connection(conn: iroh::endpoint::Connection, caller: String, handler: PeerHandler) {
    // `accept_bi()` THROWS when the connection closes; that throw is the loop's exit.
    while let Ok((send, recv)) = conn.accept_bi().await {
        let caller = caller.clone();
        let handler = handler.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_request(send, recv, caller, handler).await {
                crate::log!("serving a peer request failed: {e}");
            }
        });
    }
}

async fn serve_request(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    caller: String,
    handler: PeerHandler,
) -> Result<(), String> {
    let header_bytes = match read_frame(&mut recv, HEADER_FRAME_LIMIT)
        .await
        .map_err(|e| e.to_string())?
    {
        Ok(bytes) => bytes,
        Err(_over) => {
            // Over-limit header: answer 431 and leave the body frame UNREAD, as the protocol says.
            let head = ResponseHeader::new(431);
            let body = serde_json::json!({"code": "header_too_large"})
                .to_string()
                .into_bytes();
            write_response(&mut send, &head, PeerBody::Bytes(body)).await?;
            return Ok(());
        }
    };
    let header: RequestHeader =
        serde_json::from_slice(&header_bytes).map_err(|e| format!("bad request header: {e}"))?;

    let body_limit = (cfg().max_body_kb * 1024) as usize;
    let body = match read_frame(&mut recv, body_limit)
        .await
        .map_err(|e| e.to_string())?
    {
        Ok(bytes) => bytes,
        Err(over) => {
            // Over-limit body: the frame has been DRAINED, so it is safe to answer.
            let head = ResponseHeader::new(413);
            let payload = serde_json::json!({
                "error": format!("frame of {} bytes exceeds the {body_limit}-byte limit", over.declared),
                "code": "body_too_large",
            });
            write_response(
                &mut send,
                &head,
                PeerBody::Bytes(payload.to_string().into_bytes()),
            )
            .await?;
            return Ok(());
        }
    };

    let answer = handler(caller, header, body).await;
    let mut head = ResponseHeader::new(answer.status);
    head.headers = answer.headers;
    write_response(&mut send, &head, answer.body).await
}

async fn write_response(
    send: &mut iroh::endpoint::SendStream,
    head: &ResponseHeader,
    body: PeerBody,
) -> Result<(), String> {
    let head_json = serde_json::to_vec(head).map_err(|e| e.to_string())?;
    send.write_all(&frame(&head_json))
        .await
        .map_err(|e| e.to_string())?;
    match body {
        PeerBody::Bytes(bytes) => send.write_all(&bytes).await.map_err(|e| e.to_string())?,
        PeerBody::Stream(mut stream) => {
            use futures_lite::StreamExt as _;
            // Chunk by chunk, so a large photo never sits in memory whole on either side.
            while let Some(chunk) = stream.next().await {
                send.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
        }
    }
    send.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// True when an exchange failed because the peer went away rather than because we gave up.
pub fn is_connection_death(message: &str) -> bool {
    message.contains("connection closed before")
}

/// The stored identity, as the transport's secret key. RAW 32 bytes, base64url; the seed IS the key.
fn secret_key() -> Result<SecretKey, String> {
    let identity = crate::state::state().keys();
    let raw = URL_SAFE_NO_PAD
        .decode(&identity.private)
        .map_err(|e| format!("identity key is not base64url: {e}"))?;
    let seed: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| format!("identity seed is {} bytes, expected 32", raw.len()))?;
    Ok(SecretKey::from_bytes(&seed))
}

/// A peer's pub key as an endpoint id.
pub fn endpoint_id(pub_key: &str) -> Result<EndpointId, String> {
    let raw = URL_SAFE_NO_PAD
        .decode(pub_key)
        .map_err(|e| format!("bad peer key: {e}"))?;
    let bytes: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| format!("peer key is {} bytes, expected 32", raw.len()))?;
    EndpointId::from_bytes(&bytes).map_err(|e| format!("peer key is not a valid endpoint id: {e}"))
}

pub fn install(transport: Arc<Transport>) {
    let _ = TRANSPORT.set(transport);
}

pub fn transport() -> Option<&'static Arc<Transport>> {
    TRANSPORT.get()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_key_round_trips_through_the_endpoint_id() {
        // This is the identity contract: 32 raw bytes of a REAL ed25519 public key, base64url,
        // no padding. Derived rather than made up — see the test below for why that matters.
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let public = signing.verifying_key().to_bytes();
        let encoded = URL_SAFE_NO_PAD.encode(public);
        assert_eq!(encoded.len(), 43, "32 bytes unpadded base64url");
        let id = endpoint_id(&encoded).expect("parses");
        assert_eq!(id.as_bytes(), &public);
        assert_eq!(URL_SAFE_NO_PAD.encode(id.as_bytes()), encoded);
    }

    #[test]
    fn a_key_that_will_not_decompress_is_refused_rather_than_dialled() {
        // ed25519 decoding does check the point, but it accepts roughly HALF of all 32-byte
        // strings (all-zero, all-one and all-0xff all decode), so this is a cheap sanity check on a
        // key's shape and not a proof that a peer exists. Measured, not assumed: 0x07 repeated is
        // one of the patterns that does NOT decompress.
        assert!(endpoint_id(&URL_SAFE_NO_PAD.encode([7u8; 32])).is_err());
        // And this is the honest other half of the finding — a pattern that decodes fine.
        assert!(endpoint_id(&URL_SAFE_NO_PAD.encode([0u8; 32])).is_ok());
    }

    #[test]
    fn a_key_of_the_wrong_length_is_refused_rather_than_padded() {
        assert!(endpoint_id(&URL_SAFE_NO_PAD.encode([1u8; 31])).is_err());
        assert!(endpoint_id("not base64url!!").is_err());
    }

    #[test]
    fn the_alpn_is_the_documented_one() {
        // `isa/2` — a peer that disagrees here cannot connect at all.
        assert_eq!(PROTOCOL_ALPN, b"isa/2");
        assert_eq!(PROTOCOL_ALPN, &[105, 115, 97, 47, 50]);
    }

    #[test]
    fn a_connection_death_is_distinguished_from_a_timeout() {
        // The redial rule keys on exactly this, so the classification has to be reliable.
        assert!(is_connection_death(
            "connection closed before /hello: peer gone"
        ));
        assert!(!is_connection_death("/hello timed out after 120s"));
        assert!(!is_connection_death("dialling B failed: timeout"));
    }

    #[test]
    fn the_deadlines_are_the_documented_budgets() {
        assert_eq!(DIAL_DEADLINE.as_secs(), 10);
        assert_eq!(BYTE_HEAD_DEADLINE.as_secs(), 15);
        assert_eq!(DEADLINE.as_secs(), 120);
    }
}
