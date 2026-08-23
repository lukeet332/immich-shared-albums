# Peer lookups and nudges

`peers.ts` — who a caller is (`peerByPub`), which mapping a peer may touch (`mappingFor`), and the
fire-and-forget nudge. Transport, framing and dialing live in [`p2p/transport.ts`](./p2p/) — see
[`p2p/wire-protocol.md`](./p2p/wire-protocol.md).

## Identity is the connection

There is no signing layer. The iroh connection is mutually authenticated on the household ed25519
keys, so `callerPub` handed to every handler **is** proof — nothing to verify, nothing to replay.
A public key alone still selects nothing: it is published in redeem responses by design.

## `mappingFor` and why the peer term is the whole point

A mapping id alone selects an album. Without the `m.peer === peerPub` term, any enrolled peer could
name a mapping id and act on a relationship belonging to a **different household** — reading its
manifest, pushing refs into its album, posting comments as it. That single condition is the
boundary between "peers are enrolled" and "peers are isolated from each other".

## Nudges are fire-and-forget

When an album moves, every other household mapped to it is told to pull now rather than at its next
tick. A lost nudge costs nothing — the scheduled handshake catches everything regardless — so this
is fail-open by design and must never be made blocking.
