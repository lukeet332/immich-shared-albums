/** protocol.rs — the wire contract. Both peers must agree on every constant here. See ARCHITECTURE.md. */

/// The protocol MAJOR. Carried in the ALPN, so a future major can dual-serve the previous one and
/// needs no flag day. Independent of SIDECAR_VERSION: a release can change without a wire change.
pub const PROTOCOL_VERSION: u32 = 2;

/// ALPN bytes for protocol 2 — `isa/2`, exactly as the TypeScript build serves it.
pub const PROTOCOL_ALPN: &[u8] = b"isa/2";

/// The negotiated ALPNs this build accepts.
pub fn served_alpns() -> Vec<Vec<u8>> {
    vec![PROTOCOL_ALPN.to_vec()]
}
