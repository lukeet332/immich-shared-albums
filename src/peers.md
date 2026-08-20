# Peer transport

`peers.ts` — detached-signature sign/verify over this household's ed25519 keypair, the signed
POST/GET helpers, and the fire-and-forget nudge.

## A key names a peer; only a signature proves it

Every public key this addon holds is **published** — redeem and pair responses hand them out by
design. So a key is an identifier, never a credential. `callingPeer` therefore takes the key *and*
the signature together and verifies both; matching on the key alone would let anyone claim to be
any peer they had ever heard of.

## `mappingFor` and why the peer term is the whole point

A mapping id alone selects an album. Without the `m.peer === peerPub` term, any enrolled peer could
name a mapping id and act on a relationship belonging to a **different household** — reading its
manifest, pushing refs into its album, posting comments as it. That single condition is the
boundary between "peers are enrolled" and "peers are isolated from each other".

## SSRF guard on peer-supplied URLs

`assertPeerUrlAllowed` runs before this addon fetches anything a peer told it about. Private
destinations are normal for LAN and tailnet deployments, so they are allowed unless
`ALLOW_PRIVATE_PEERS=false` — which is what a publicly reachable host should set, so a peer URL
cannot be aimed at services only the container can reach.

## Nudges are fire-and-forget

When an album moves, every other household mapped to it is told to pull now rather than at its next
tick. A lost nudge costs nothing — the scheduled handshake catches everything regardless — so this
is fail-open by design and must never be made blocking.
