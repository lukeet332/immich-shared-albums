/** p2p/nudges.rs — the nudge paths, and the one place a nudge is sent. See docs/wire-protocol.md. */
use crate::p2p::frame::RequestHeader;
use crate::store::Peer;

/// The exact nudge paths, as the ROUTER matches them too. One spelling for both sides is the point:
/// a nudge sent to a path no route serves, or a route no sender uses, is a nudge that silently does
/// nothing and leaves the lane on its backstop.
pub const INDEX: &str = "/index/nudge";
pub const DIRECTORY: &str = "/nudge/directory";
pub const COMMENTS: &str = "/nudge/comments";
pub const INVITATIONS: &str = "/invitations/nudge";

/// `POST /albums/:mappingId/nudge` — "look at this album again".
///
/// The GETTER shape is deliberate: the router strips the same prefix and suffix, so the format lives
/// here once rather than in a `format!` at every call site.
pub fn album_path(album_mapping_id: &str) -> String {
    format!("/albums/{album_mapping_id}/nudge")
}

/// Send one nudge, fire-and-forget.
///
/// Never awaited: a nudge says "look again" and carries nothing, so losing one costs the latency of
/// the next backstop sweep and nothing else — and a caller answering a request must not wait on a
/// peer's dial. A missing transport (a build with the peer transport off) is a silent no-op, which
/// is the same fail-open path as a lost nudge.
pub fn send(peer: &Peer, path: String) {
    let Some(transport) = crate::p2p::transport::transport() else {
        return;
    };
    let peer = peer.clone();
    tokio::spawn(async move {
        let header = RequestHeader {
            path,
            ..Default::default()
        };
        let _ = transport.round_trip(&peer, &header, None).await;
    });
}

/// The same nudge to every peer. One header each, because a nudge names no album of its own.
pub fn broadcast(peers: impl IntoIterator<Item = Peer>, path: &str) {
    for peer in peers {
        send(&peer, path.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_album_nudge_path_is_the_one_the_router_strips() {
        assert_eq!(album_path("mapping-1"), "/albums/mapping-1/nudge");
        // The router reads this path back with `strip_prefix("/albums/")` and
        // `strip_suffix("/nudge")`, so the two halves must stay the same shape.
        let path = album_path("mapping-1");
        assert_eq!(
            path.strip_prefix("/albums/")
                .and_then(|rest| rest.strip_suffix("/nudge")),
            Some("mapping-1")
        );
    }

    #[test]
    fn every_lane_nudge_that_has_a_route_is_named_here() {
        // Pinned so a rename cannot leave a sender addressing a route that no longer exists.
        assert_eq!(INDEX, "/index/nudge");
        assert_eq!(DIRECTORY, "/nudge/directory");
        assert_eq!(COMMENTS, "/nudge/comments");
        assert_eq!(INVITATIONS, "/invitations/nudge");
    }
}
