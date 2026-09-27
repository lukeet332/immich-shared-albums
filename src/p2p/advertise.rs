/** p2p/advertise.rs — the addresses this server tells peers to dial. See docs/wire-protocol.md. */
use crate::config::{cfg, AdvertiseAddr};
use crate::p2p::transport::Transport;
use std::time::Duration;

/// The address list a pairing ticket or share-page token carries, given the DECLARED address
/// resolved to an IPv4 literal (or not) and the endpoint's own addresses. The declared one leads
/// because with the relay off it is the only candidate a peer outside this container's networks
/// can dial; with the relay on, iroh races all of them anyway. A resolved address that is already
/// among our own is not repeated.
fn assemble(resolved_ip: Option<String>, port: u16, own: &[String]) -> Vec<String> {
    match resolved_ip {
        None => own.to_vec(),
        Some(ip) => {
            let reachable = format!("{ip}:{port}");
            let mut out = vec![reachable.clone()];
            out.extend(own.iter().filter(|a| a.as_str() != reachable).cloned());
            out
        }
    }
}

/// The DNS deadline. A stalled resolver must not hold a pairing mint or a share page hostage:
/// the honest answer while DNS is unhealthy is our own addresses, not a hung request.
pub const RESOLVE_DEADLINE: Duration = Duration::from_secs(3);

/// The declared host, resolved to an IPv4 literal. IPv4 only: the transport binds
/// `0.0.0.0:ISA_P2P_PORT`, so an AAAA answer would name a port nothing is listening on. A
/// resolver still running past the deadline reads as unresolved.
async fn resolve_ipv4(host: &str, port: u16) -> Option<String> {
    let host = host.to_string();
    let lookup = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (host.as_str(), port)
            .to_socket_addrs()
            .ok()
            .and_then(|mut all| all.find(|a| a.is_ipv4()))
            .map(|a| a.ip().to_string())
    });
    tokio::time::timeout(RESOLVE_DEADLINE, lookup)
        .await
        .ok()
        .and_then(|done| done.ok())
        .flatten()
}

/// What a pairing ticket or share-page token carries. The declared address
/// (`ISA_ADVERTISE_ADDR`) is resolved HERE and now — a link is a point-in-time address, so a
/// stale answer is worse than a fresh failure. A host that does not resolve logs and falls back
/// to the endpoint's own addresses: minting a link must never fail because DNS did.
pub async fn advertised_addresses(transport: &Transport) -> Vec<String> {
    let own = transport.direct_addresses();
    let Some(declared) = cfg().advertise_addr.clone() else {
        return own;
    };
    let AdvertiseAddr { host, port } = &declared;
    let resolved = match resolve_ipv4(host, *port).await {
        Some(ip) => Some(ip),
        None => {
            crate::log!(
                "ISA_ADVERTISE_ADDR: {host} did not resolve — peers get this host's own addresses"
            );
            None
        }
    };
    assemble(resolved, *port, &own)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoint's own addresses, as `direct_addresses()` hands them over.
    fn own(addrs: &[&str]) -> Vec<String> {
        addrs.iter().map(|a| a.to_string()).collect()
    }

    const OWN: [&str; 2] = ["172.26.0.6:8300", "192.168.1.251:8300"];

    #[test]
    fn with_nothing_declared_peers_get_exactly_our_own_addresses() {
        assert_eq!(assemble(None, 8300, &own(&OWN)), own(&OWN));
        assert_eq!(assemble(None, 8300, &[]), Vec::<String>::new());
    }

    #[test]
    fn the_declared_address_leads_because_it_is_what_a_peer_outside_our_network_can_dial() {
        assert_eq!(
            assemble(Some("203.0.113.9".into()), 8300, &own(&OWN)),
            own(&["203.0.113.9:8300", "172.26.0.6:8300", "192.168.1.251:8300"])
        );
    }

    #[test]
    fn an_address_we_already_advertise_is_not_repeated_when_it_is_also_declared() {
        assert_eq!(
            assemble(
                Some("192.168.1.251".into()),
                8300,
                &own(&["192.168.1.251:8300", "172.26.0.6:8300"])
            ),
            own(&["192.168.1.251:8300", "172.26.0.6:8300"])
        );
    }
}
