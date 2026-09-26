/** p2p/pair.rs — pairing links two servers on their own, with no album involved. See ARCHITECTURE.md. */
use crate::config::{cfg, SIDECAR_VERSION};
use crate::p2p::transport::{is_connection_death, Transport};
use crate::protocol::PROTOCOL_VERSION;
use crate::settings::Settings;
use crate::state::state;
use crate::store::{Peer, Store};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;

/// A minted code, as it is STORED: only the hash. The ticket itself is shown exactly once, so
/// nothing can re-display it — us included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingCode {
    #[serde(rename = "codeHash")]
    pub code_hash: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
}

/// The `isa2-` ticket a peer is handed. `v` is the TICKET version, separate from the wire protocol
/// version: the envelope can change without the protocol changing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub v: u32,
    #[serde(rename = "pub")]
    pub pub_key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub relay: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub addrs: Option<Vec<String>>,
    pub secret: String,
}

pub fn hash_code(code: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code.as_bytes()))
}

fn load(store: &Store) -> Vec<PairingCode> {
    store
        .kv("pairings")
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn persist(store: &Store, list: &[PairingCode]) {
    let _ = store.kv_set(
        "pairings",
        &serde_json::to_value(list).unwrap_or(Value::Array(vec![])),
    );
}

/// Drop anything expired. Called on every read path so stale codes cannot pile up.
pub fn live(store: &Store) -> Vec<PairingCode> {
    let now = now_ms();
    let all = load(store);
    let kept: Vec<PairingCode> = all.iter().filter(|p| p.expires_at > now).cloned().collect();
    if kept.len() != all.len() {
        persist(store, &kept);
    }
    kept
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Mint a code and return the ticket to hand to the other admin — the ONE time it is visible.
pub fn mint_pairing(transport: &Transport, store: &Store) -> Result<(String, i64), String> {
    let mut secret_bytes = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut secret_bytes);
    let code = URL_SAFE_NO_PAD.encode(secret_bytes);

    let ttl_ms = Settings::read(store).pairing_ttl_minutes * 60 * 1000;
    let now = now_ms();
    let entry = PairingCode {
        code_hash: hash_code(&code),
        created_at: now,
        expires_at: now + ttl_ms,
    };
    let mut list = live(store);
    list.push(entry.clone());
    persist(store, &list);

    let mut ticket = Ticket {
        v: 2,
        pub_key: transport.public_key(),
        relay: transport.relay_url(),
        addrs: Some(transport.direct_addresses()),
        secret: code,
    };
    if ticket.addrs.as_ref().map(|a| a.is_empty()).unwrap_or(true) {
        ticket.addrs = None;
    }
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_string(&ticket).unwrap_or_default());
    crate::log!(
        "minted a pairing code, valid for {} minutes",
        ttl_ms / 60000
    );
    Ok((format!("isa2-{encoded}"), entry.expires_at))
}

/// Parse a pasted ticket. The shape is narrow on purpose: an `isa2-` prefix, base64url only, and a
/// version this build knows.
pub fn parse_ticket(raw: &str) -> Option<Ticket> {
    let trimmed = raw.trim();
    let body = trimmed.strip_prefix("isa2-")?;
    if body.is_empty()
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(body).ok()?;
    let ticket: Ticket = serde_json::from_slice(&decoded).ok()?;
    if ticket.v == 2 && !ticket.pub_key.is_empty() && !ticket.secret.is_empty() {
        Some(ticket)
    } else {
        None
    }
}

/// What the panel shows: unredeemed codes, newest first — metadata only, never the ticket.
pub fn pending_pairings(store: &Store) -> Vec<Value> {
    let mut list = live(store);
    list.sort_by_key(|p| std::cmp::Reverse(p.created_at));
    list.iter()
        .map(|p| {
            json!({
                "id": &p.code_hash[..12.min(p.code_hash.len())],
                "createdAt": p.created_at,
                "expiresAt": p.expires_at,
            })
        })
        .collect()
}

/// Revoke by the ticket itself (paste-back) or by a pending entry's id.
pub fn revoke_pairing(store: &Store, code_or_id: &str) {
    let as_hash = hash_code(code_or_id);
    let kept: Vec<PairingCode> = live(store)
        .into_iter()
        .filter(|p| {
            p.code_hash != as_hash && &p.code_hash[..12.min(p.code_hash.len())] != code_or_id
        })
        .collect();
    persist(store, &kept);
}

/// Hashes are fixed-length, so this stays constant-time without a length dance.
fn code_matches(store: &Store, candidate: &str) -> Option<PairingCode> {
    let want = hash_code(candidate);
    live(store)
        .into_iter()
        .find(|p| p.code_hash.as_bytes().ct_eq(want.as_bytes()).into())
}

/// MINTING side: another server is redeeming a code we issued.
///
/// The connection already proved the caller holds the key being enrolled; the secret proves an
/// admin HERE invited them. Consuming the code before answering means a replay finds nothing.
pub async fn handle_pair(transport: &Transport, caller_pub: &str, body: &[u8]) -> (u16, Value) {
    let Ok(parsed) = serde_json::from_slice::<Value>(body) else {
        return (400, json!({ "error": "malformed request" }));
    };
    let code = parsed
        .get("code")
        .and_then(|c| c.as_str())
        .unwrap_or_default();
    let household_name = parsed
        .pointer("/household/name")
        .and_then(|n| n.as_str())
        .unwrap_or_default();
    if code.is_empty() || household_name.is_empty() {
        return (400, json!({ "error": "malformed pairing request" }));
    }

    let store = &state().store;
    let Some(entry) = code_matches(store, code) else {
        crate::log!("pairing refused: unknown or expired code");
        return (
            403,
            json!({ "error": "that pairing link is not valid — it may have expired or been used" }),
        );
    };

    // SINGLE-USE: burn it before doing anything else, so a replay cannot land twice.
    let remaining: Vec<PairingCode> = live(store)
        .into_iter()
        .filter(|p| p.code_hash != entry.code_hash)
        .collect();
    persist(store, &remaining);

    let version = parsed
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    {
        let mut collections = state().collections();
        match collections
            .peers
            .iter_mut()
            .find(|p| p.pub_key == caller_pub)
        {
            Some(existing) => {
                if !household_name.is_empty() {
                    existing.name = household_name.to_string();
                }
                if version.is_some() {
                    existing.version = version;
                }
            }
            None => collections.peers.push(Peer {
                pub_key: caller_pub.to_string(),
                name: household_name.to_string(),
                version,
                protocol: Some(PROTOCOL_VERSION as i64),
                features: None,
                via: "pair".to_string(),
                first_seen_at: crate::config::iso_now(),
                relay_hint: None,
                last_addrs: None,
            }),
        }
    }
    let _ = state().save();
    crate::log!("paired with \"{household_name}\" — their people can now be invited to albums");

    // A LINK IS USEFUL THE MOMENT IT EXISTS: offer the admin account's own albums to the peer that
    // just paired, before anyone opens a panel. Not ported yet (album-index), so it is LOGGED
    // rather than silently skipped — the panel's first visit offers them anyway.
    crate::log!("note: offering this server's albums to the new peer is not ported yet");

    let _ = transport;
    (
        200,
        json!({
            "household": { "publicKey": state().keys().public, "name": cfg().name },
            "protocol": PROTOCOL_VERSION,
            "version": SIDECAR_VERSION,
        }),
    )
}

/// REDEEMING side: an admin pasted a ticket another server gave them.
///
/// One round trip pairs both ends: they learn our key from the connection itself, we learn theirs
/// from the ticket — and the dial only succeeds if the far end HOLDS that key, so the identity in
/// the ticket is verified by CONNECTING, not by trusting the answer.
pub async fn redeem_pairing(transport: Arc<Transport>, raw_ticket: &str) -> Result<Value, String> {
    let ticket = parse_ticket(raw_ticket).ok_or("that does not look like a server link")?;
    if ticket.pub_key == transport.public_key() {
        return Err("that link is for this server".to_string());
    }
    let peer = Peer {
        pub_key: ticket.pub_key.clone(),
        name: "pairing".to_string(),
        version: None,
        protocol: None,
        features: None,
        via: "pair".to_string(),
        first_seen_at: crate::config::iso_now(),
        relay_hint: ticket.relay.clone(),
        last_addrs: ticket.addrs.clone(),
    };
    let body = json!({
        "code": ticket.secret,
        "protocol": PROTOCOL_VERSION,
        "version": SIDECAR_VERSION,
        "household": { "publicKey": transport.public_key(), "name": cfg().name },
    })
    .to_string();
    let header = crate::p2p::frame::RequestHeader {
        path: "/pair".to_string(),
        ..Default::default()
    };
    let (head, body) = transport
        .round_trip(&peer, &header, Some(body.as_bytes()))
        .await
        .map_err(|e| {
            if is_connection_death(&e) {
                "that server could not be reached".to_string()
            } else {
                e
            }
        })?;
    if head.status != 200 {
        let reason = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("status {}", head.status));
        return Err(reason);
    }
    let answer: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let linked = answer
        .pointer("/household/name")
        .and_then(|n| n.as_str())
        .unwrap_or("the other server")
        .to_string();

    // Record the link we just proved. The identity came from the CONNECTION, so `ticket.pub_key`
    // is what we dialled and what the far end proved it holds.
    {
        let mut collections = state().collections();
        if !collections
            .peers
            .iter()
            .any(|p| p.pub_key == ticket.pub_key)
        {
            collections.peers.push(Peer {
                name: linked.clone(),
                version: answer
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                protocol: answer.get("protocol").and_then(|p| p.as_i64()),
                features: None,
                ..peer.clone()
            });
        }
    }
    let _ = state().save();
    Ok(json!({ "linked": linked }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn a_code_is_stored_only_as_a_hash() {
        let s = store();
        let code = "a-secret-code";
        let list = vec![PairingCode {
            code_hash: hash_code(code),
            created_at: now_ms(),
            expires_at: now_ms() + 60_000,
        }];
        persist(&s, &list);
        let raw = s.kv("pairings").unwrap().unwrap().to_string();
        // The secret must never be recoverable from what persists.
        assert!(!raw.contains(code), "the code itself must not be stored");
        assert!(raw.contains(&hash_code(code)));
    }

    #[test]
    fn expired_codes_are_dropped_on_read() {
        let s = store();
        persist(
            &s,
            &[
                PairingCode {
                    code_hash: hash_code("old"),
                    created_at: 0,
                    expires_at: 1,
                },
                PairingCode {
                    code_hash: hash_code("new"),
                    created_at: now_ms(),
                    expires_at: now_ms() + 60_000,
                },
            ],
        );
        let kept = live(&s);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].code_hash, hash_code("new"));
        // And the drop is persisted, so stale rows cannot pile up.
        assert_eq!(live(&s).len(), 1);
    }

    #[test]
    fn only_the_right_code_matches() {
        let s = store();
        persist(
            &s,
            &[PairingCode {
                code_hash: hash_code("right"),
                created_at: now_ms(),
                expires_at: now_ms() + 60_000,
            }],
        );
        assert!(code_matches(&s, "right").is_some());
        assert!(code_matches(&s, "wrong").is_none());
        assert!(code_matches(&s, "").is_none());
    }

    #[test]
    fn revoking_works_by_ticket_and_by_the_panel_id() {
        let s = store();
        let code = "revoke-me";
        persist(
            &s,
            &[PairingCode {
                code_hash: hash_code(code),
                created_at: now_ms(),
                expires_at: now_ms() + 60_000,
            }],
        );
        // By the ticket itself, as a paste-back.
        revoke_pairing(&s, code);
        assert!(live(&s).is_empty());

        // And by the 12-character id the panel shows.
        persist(
            &s,
            &[PairingCode {
                code_hash: hash_code(code),
                created_at: now_ms(),
                expires_at: now_ms() + 60_000,
            }],
        );
        let id = hash_code(code)[..12].to_string();
        revoke_pairing(&s, &id);
        assert!(live(&s).is_empty());
    }

    #[test]
    fn a_ticket_round_trips_through_its_string_form() {
        let ticket = Ticket {
            v: 2,
            pub_key: "A".repeat(43),
            relay: Some("https://relay.example/".into()),
            addrs: Some(vec!["1.2.3.4:8300".into()]),
            secret: "s3cret".into(),
        };
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_string(&ticket).unwrap());
        let parsed = parse_ticket(&format!("isa2-{encoded}")).expect("parses");
        assert_eq!(parsed.v, 2);
        assert_eq!(parsed.pub_key, ticket.pub_key);
        assert_eq!(parsed.secret, "s3cret");
        assert_eq!(parsed.relay.as_deref(), Some("https://relay.example/"));
    }

    #[test]
    fn a_malformed_ticket_is_refused_rather_than_guessed_at() {
        assert!(parse_ticket("").is_none());
        assert!(parse_ticket("isa2-").is_none());
        assert!(parse_ticket("nope").is_none());
        // Whitespace around a good ticket is tolerated, as a paste brings it.
        let good = URL_SAFE_NO_PAD.encode(
            serde_json::to_string(&Ticket {
                v: 2,
                pub_key: "B".repeat(43),
                relay: None,
                addrs: None,
                secret: "s".into(),
            })
            .unwrap(),
        );
        assert!(parse_ticket(&format!("  isa2-{good}\n")).is_some());
        // A ticket from a future version is not this build's to guess at.
        let v3 = URL_SAFE_NO_PAD
            .encode(serde_json::to_string(&json!({"v": 3, "pub": "C", "secret": "s"})).unwrap());
        assert!(parse_ticket(&format!("isa2-{v3}")).is_none());
        // Characters outside base64url never reach the decoder.
        assert!(parse_ticket("isa2-abc!def").is_none());
    }

    #[test]
    fn pending_pairings_expose_only_metadata_never_the_ticket() {
        let s = store();
        let code = "top-secret";
        persist(
            &s,
            &[PairingCode {
                code_hash: hash_code(code),
                created_at: now_ms(),
                expires_at: now_ms() + 60_000,
            }],
        );
        let shown = pending_pairings(&s);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["id"].as_str().unwrap().len(), 12);
        let rendered = serde_json::to_string(&shown).unwrap();
        assert!(
            !rendered.contains(code),
            "the panel is shown the hash prefix, never the ticket"
        );
    }
}
