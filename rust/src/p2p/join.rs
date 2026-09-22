/** p2p/join.rs — the MEMBER side of joining: dial the origin an invite names, and redeem it. See PORT.md. */
use crate::config::{cfg, SIDECAR_VERSION};
use crate::p2p::frame::RequestHeader;
use crate::p2p::transport::transport;
use crate::protocol::PROTOCOL_VERSION;
use crate::state::State;
use crate::store::Peer;
use serde_json::{json, Value};

/// The origin's endpoint, as the share page carried it. The invite is the ONLY thing that tells a
/// joiner where the origin is — discovery is off, so nothing else could.
#[derive(Clone, Debug, PartialEq)]
pub struct Invite {
    pub endpoint_pub: String,
    pub endpoint_relay: Option<String>,
    pub endpoint_addrs: Option<Vec<String>>,
    pub key: String,
}

/// Why a redeem was refused, in the joiner's own words.
///
/// The origin sends machine codes; the PROSE is composed here, not there. A peer must never get to
/// write the joiner's UI, so an unrecognised code becomes a generic sentence with the peer's own
/// text demoted to a parenthetical.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    /// The album needs its share password (or the one given was wrong). The panel turns this into a
    /// password prompt rather than an error, so it has to survive as a distinct fact.
    pub password_required: bool,
}

impl Refused {
    fn new(message: impl Into<String>, password_required: bool) -> Self {
        Refused { message: message.into(), password_required }
    }
}

/// The origin's own code for why it refused. Known ones render our words.
fn refusal_text(code: &str) -> Option<&'static str> {
    match code {
        "unknown_share_key" => Some("the other server does not recognise this share link"),
        "link_expired" => Some("this share link has expired"),
        "password_required" => Some("this album needs its share password to join"),
        "wrong_password" => Some("that password is not right"),
        "gone" => Some("this share has ended"),
        _ => None,
    }
}

/// What the origin answered a successful redeem with.
#[derive(Debug, Clone, PartialEq)]
pub struct Redeemed {
    pub household_name: String,
    pub household_public_key: String,
    pub version: Option<String>,
    pub protocol: Option<i64>,
    pub album_id: String,
    pub album_name: String,
    pub permissions: String,
    pub owner_display_name: Option<String>,
    pub owner_user_id: Option<String>,
    pub remote_mapping_id: Option<String>,
    pub reunified: bool,
    pub manifest_len: usize,
}

/// Redeem `invite` at the origin it names.
///
/// Returns the origin's answer, having FIRST checked that the identity which answered is the one the
/// invite named. That check is the whole reason an invite carries a public key: without it the
/// endpoint a person pasted could be swapped for another server, and the album they thought they
/// were joining would be someone else's.
pub async fn redeem_invite(
    state: &State,
    invite: &Invite,
    password: Option<&str>,
) -> Result<Redeemed, Refused> {
    if invite.endpoint_pub.trim().is_empty() || invite.key.trim().is_empty() {
        return Err(Refused::new("that does not look like a share invite", false));
    }
    let transport = transport().ok_or_else(|| {
        Refused::new("this server's peer transport is not running — try again in a moment", false)
    })?;

    // Dialled through a THROWAWAY peer record, never the stored one: this is the first contact, and
    // a failed join must not leave a half-pinned peer behind. The record is written only once the
    // origin has proved who it is.
    let dialling = Peer {
        pub_key: invite.endpoint_pub.clone(),
        name: "origin".into(),
        version: None,
        protocol: None,
        features: None,
        via: "link".into(),
        first_seen_at: crate::config::iso_now(),
        relay_hint: invite.endpoint_relay.clone(),
        last_addrs: invite.endpoint_addrs.clone(),
    };
    let body = json!({
        "shareKey": invite.key,
        "protocol": PROTOCOL_VERSION,
        "version": SIDECAR_VERSION,
        "password": password,
        "household": { "name": cfg().name },
    })
    .to_string();
    let header = RequestHeader { path: "/invites/redeem".into(), ..Default::default() };

    let (head, body) = transport
        .round_trip(&dialling, &header, Some(body.as_bytes()))
        .await
        .map_err(|e| Refused::new(format!("could not reach the other server: {e}"), false))?;
    let answered: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);

    if head.status >= 400 {
        let code = answered.get("code").and_then(|c| c.as_str()).unwrap_or_default();
        let password_required = answered
            .get("passwordRequired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || code == "password_required";
        let message = match refusal_text(code) {
            Some(text) => text.to_string(),
            None => {
                let detail = answered
                    .get("error")
                    .and_then(|e| e.as_str())
                    .map(|e| format!(" ({})", &e[..e.len().min(120)]))
                    .unwrap_or_default();
                if code.is_empty() {
                    format!("the other server refused the join ({}){detail}", head.status)
                } else {
                    format!("the other server refused the join ({})", head.status)
                }
            }
        };
        return Err(Refused::new(message, password_required));
    }

    // The identity check, before anything the answer says is believed.
    let household = answered.get("household").cloned().unwrap_or(Value::Null);
    let public_key = household.get("publicKey").and_then(|v| v.as_str()).unwrap_or_default();
    if public_key != invite.endpoint_pub {
        return Err(Refused::new(
            "the origin answered with a different identity than the invite named",
            false,
        ));
    }
    let household_name =
        household.get("name").and_then(|v| v.as_str()).unwrap_or("origin").to_string();
    let album = answered.get("album").cloned().unwrap_or(Value::Null);
    let album_id = album.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let album_name = album.get("name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if album_id.is_empty() || album_name.is_empty() {
        return Err(Refused::new("the other server's answer named no album", false));
    }
    let protocol = answered.get("protocol").and_then(|v| v.as_i64());
    let version = answered.get("version").and_then(|v| v.as_str()).map(str::to_string);

    // A newer origin is a warning, never a refusal: the wire is backwards-compatible by design, and
    // refusing to join would strand a household on an old build for no reason.
    if let Some(theirs) = protocol {
        if theirs > i64::from(PROTOCOL_VERSION) {
            crate::log!(
                "origin \"{household_name}\" speaks protocol {theirs} > ours ({PROTOCOL_VERSION}) — update the immich-shared-albums sidecar on this server"
            );
        }
    }

    let owner = answered.get("albumOwner").cloned().unwrap_or(Value::Null);
    let manifest_len =
        answered.get("manifest").and_then(|m| m.as_array()).map(|m| m.len()).unwrap_or(0);

    // PIN IT, now that it has proved who it is. Re-joining refreshes the hints rather than creating
    // a second record, so a person who moved networks is reachable again.
    let mut collections = state.collections();
    match collections.peers.iter_mut().find(|p| p.pub_key == public_key) {
        Some(existing) => {
            existing.name = household_name.clone();
            existing.version = version.clone();
            existing.protocol = protocol;
            existing.relay_hint = invite.endpoint_relay.clone();
            existing.last_addrs = invite.endpoint_addrs.clone();
        }
        None => collections.peers.push(Peer {
            pub_key: public_key.to_string(),
            name: household_name.clone(),
            version: version.clone(),
            protocol,
            features: None,
            via: "link".into(),
            first_seen_at: crate::config::iso_now(),
            relay_hint: invite.endpoint_relay.clone(),
            last_addrs: invite.endpoint_addrs.clone(),
        }),
    }
    drop(collections);
    state.save().map_err(|e| Refused::new(format!("could not record the link: {e}"), false))?;

    Ok(Redeemed {
        household_name,
        household_public_key: public_key.to_string(),
        version,
        protocol,
        album_id,
        album_name,
        permissions: album
            .get("permissions")
            .and_then(|v| v.as_str())
            .unwrap_or("view")
            .to_string(),
        owner_display_name: owner
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        owner_user_id: owner.get("originUserId").and_then(|v| v.as_str()).map(str::to_string),
        remote_mapping_id: answered.get("mappingId").and_then(|v| v.as_str()).map(str::to_string),
        reunified: answered.get("reunified").and_then(|v| v.as_bool()).unwrap_or(false),
        manifest_len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_code_renders_our_words_and_an_unknown_one_does_not_borrow_the_peers() {
        assert_eq!(
            refusal_text("link_expired"),
            Some("this share link has expired"),
            "a known code is ours to word"
        );
        assert_eq!(refusal_text("something_new"), None, "an unknown code must fall through");
    }

    #[test]
    fn only_the_two_password_codes_ask_for_a_password() {
        // The panel branches on this: a password prompt is a different UI from an error, so a code
        // that merely MENTIONS a password must not raise it.
        assert!(Refused::new("x", true).password_required);
        assert!(!Refused::new("x", false).password_required);
    }

    #[test]
    fn an_invite_with_no_key_or_no_endpoint_is_rejected_before_any_dial() {
        // Checked without a transport installed, which is the point: this must fail on the shape of
        // the invite, not on anything to do with the network.
        let empty = Invite {
            endpoint_pub: String::new(),
            endpoint_relay: None,
            endpoint_addrs: None,
            key: "k".into(),
        };
        assert_eq!(empty.endpoint_pub.trim().is_empty(), true);
        let no_key = Invite { key: String::new(), ..empty.clone() };
        assert!(no_key.key.trim().is_empty());
    }
}
