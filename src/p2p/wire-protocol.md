# `p2p/` — the cross-server wire protocol

How two sidecars introduce themselves and move album state between servers — over **iroh**:
mutually authenticated QUIC that dials the household's ed25519 key. `Household.publicKey` IS the
endpoint id, so "URLs are hints; identity is the key" is now literal: there are no peer URLs, no
certificates, and no listening HTTP surface for peers at all.

## Transport (`transport.ts`) and routes (`routes.ts`)

- ALPN `isa/2`, `PROTOCOL_VERSION = 2`. One bi-stream per request: u32-LE length-prefixed JSON
  header `{path, range?}` + length-prefixed body; response header `{status, headers?}` + body
  streamed to FIN. `Range` rides the frame header (seekable video).
- Dialing needs the key plus hints: `Peer.relayHint`/`Peer.lastAddrs`, refreshed after every
  successful dial — **hints, never identity**. First contact gets them from the pairing ticket or
  the share page's endpoint token.
- Connections are cached per peer and redialed on close. The accept loop hands `routes.ts` the
  caller's proven key (`remoteId()`), never a header.
- **Relays**: n0's public map assists hole-punching and carries end-to-end-encrypted traffic when
  a direct path fails — the one disclosed third party, fallback only; `RELAY=off` runs dark.
  **Discovery is never enabled** — tickets and tokens carry the address, so no registry learns a
  server exists.

| File             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.ts`   | The iroh endpoint: lifecycle (the endpoint secret IS the household key's seed), dial-by-key with self-refreshing hints, the frame codec, `peerRequest`/`peerByteRequest`.                                                                                                                                                                                                                                                                                                                                     |
| `routes.ts`      | The peer route table, served from the accept loop — the only place peer operations exist. Gates `/invites/redeem` on the panel's `shareLinkJoin` setting.                                                                                                                                                                                                                                                                                                                                                     |
| `protocol.ts`    | Inbound handlers, mostly owner-side. `handleRedeem` turns a share key into a pinned peer + mapping and returns the manifest; `handleRefs` accepts pushed photos; `handleVersion`/`handleManifest` answer the cheap handshake and the full offer set; `handleNudge` reacts to "something moved, pull now". Each returns `[status, jsonBody]` for `routes.ts` to frame.                                                                                                                                         |
| `pair.ts`        | Linking two servers as its own act. Mints an `isa2-…` ticket — this endpoint's key + dial hints + a single-use, 15-minute, 32-byte secret — and `handlePair` burns the secret **before** answering, so a replay finds nothing. The redeeming side dials the ticket's key, and the dial only succeeds if the far end holds it: identity is verified by connecting. Pairing conveys **no album access** — what the two servers may see of each other is decided afterwards, per person, in Immich's own picker. |
| `join.ts`        | The **member side** of joining. Dials the endpoint carried by the invite, redeems the share key, pins the peer (refusing an origin that answers with a different identity than the invite named), creates the local mirror, and kicks off the first reconcile. Idempotent — re-joining adds the user to the existing mirror.                                                                                                                                                                                  |
| `mirror.ts`      | Creating the local mirror of a remote album — the account-owner, local members as editors, the mapping, and the background fill. Shared by `join.ts` (share link) and `sync/invites.ts` (native invitation): two ways to acquire an album, one way to mirror it.                                                                                                                                                                                                                                              |
| `entitlement.ts` | What a peer may **read**, as distinct from who it is. Records every asset advertised to a mapping, and answers the byte routes' "is this peer allowed this asset".                                                                                                                                                                                                                                                                                                                                            |
| `unlink.ts`      | Cutting a server link, from the panel. Tears down mirrors held from that peer (via `sync/leave.ts`, so their stubs go too), drops the mappings and entitlement for albums shared _to_ them, and deletes that peer's per-person accounts with `force: true` — **assets leave with their owner**. Unlinking is destructive by design, and the panel confirms it.                                                                                                                                                |

**The share-link handshake, end to end:** the origin's share page embeds its endpoint token → the
join card forwards it in the v2 invite fragment (never a server log) → the visitor's own sidecar
dials the origin and redeems → the origin pins the caller's proven key and returns the manifest →
the joiner materialises it via `sync/`. The origin's HTTPS exists for the _page_; the protocol leg
needs no exposed surface anywhere.

## What the connection does and does not prove

The mutual TLS handshake proves **which peer is calling** — channel-bound, replay-proof, encrypted,
forward-secret. On its own it says nothing about what that peer may touch, and treating the two as
the same thing is how a peer-to-peer protocol turns into an open door. Two rules follow, and every
inbound handler keeps them:

1. **Look mappings up _with_ the caller.** `peers.mappingFor` always filters on
   `m.peer === peerPub`. Without that term a mapping id alone selects an album, and any enrolled
   peer can act on a relationship belonging to a different household.
2. **A nudge is a hint, never a source.** `handleNudge` reconciles against the mapping's own
   origin, never against whoever sent the nudge — otherwise a peer could nominate itself as the
   source of truth for someone else's album and plant content in it.

## Enrolment

`handleRedeem` and `handlePair` are the routes that run before a relationship exists. Both rest on:

- **The connection itself.** The caller's key is proven by the handshake, so the enrolled identity
  is whatever dialed — nothing to forge, nothing to substitute, no trust-on-first-use step left to
  get wrong.
- **A grant an admin or owner actually made**: a pairing secret (single-use, burned before the
  answer) or a share key, whose own rules — expiry, password (constant-time compared),
  `ISA_LINK_JOIN_REQUIRES_PASSWORD` — are honoured exactly as Immich's share page honours them.
- **Idempotency.** Re-redeeming reuses the existing mapping rather than minting another, so a
  valid grant is not an unbounded state-growth lever.

A share link stays a **bearer** grant for its one album — anyone holding it (and its password) can
join. Pairing is the non-bearer path, and the panel's `shareLinkJoin` setting can close the
share-link door entirely (redeem answers 403).

## The version handshake

One cheap album read instead of a full manifest scan, so members can skip untouched albums. Note
`updatedAt` alone misses cascade deletions — removing an asset from the library does not touch the
albums containing it — so the asset count travels with the version.

**`version` is an opaque equality token.** It is compared for equality against a stored cursor and
nothing else: it is not ordered, must never be compared with `<`/`>`, and restoring an origin from
backup is safe _because_ equality is the only test. Receivers read the structured fields
(`updatedAt`, `assetCount`, `comments`) and never parse the string.

## The manifest is the reconciliation sweep

Members re-pull it every poll and materialise anything missing, which is what heals refs dropped at
join time or lost to a failed push. It lists **human-owned photos only** — proxy stubs are
excluded, so reconciliation can never echo a household's own photos back to it.

## Nudges are fire-and-forget

When an album moves, every OTHER household mapped to it is told to pull now rather than at its next
tick. A lost nudge costs nothing: the scheduled handshake catches everything regardless, so this is
fail-open by design and must never be made blocking.

## Pushed refs report partial success

The sender re-offers only the failed refs next cycle. Pushes are **chunked** (400 refs per
frame): the receiver's `ISA_MAX_BODY_KB` caps any one frame, an over-limit frame is answered
with `413`/`body_too_large` rather than abandoned, and every client read carries a deadline —
a hung peer costs one timeout, never a wedged loop.

## How this protocol evolves

The rules that make additive change legal, written down so nobody has to re-derive them:

1. **Unknown JSON fields MUST be ignored**, in request bodies, response bodies, and the frame
   headers. Adding an optional field is never a breaking change.
2. **Unknown routes answer 404**, and callers treat a 404 from a route added after protocol 2
   as "peer too old", never as an error. Adding a route is never a breaking change.
3. **The ALPN carries the protocol MAJOR** (`isa/2`). A future major keeps serving the previous
   ALPN for at least one major and prefers the newest the dialer offers; the accept loop reads
   the negotiated ALPN per connection, so dual-serving needs no flag day.
4. **`/hello`** (`{protocol, version, features[]}`) is how peers learn each other's
   capabilities; answers are persisted per peer and refreshed each boot. A 404 means a
   protocol-2 build from before the route existed. New behaviour gates on a feature flag,
   never on a version comparison.
5. **Errors carry machine `code`s** alongside human `error` prose. Receivers render their own
   words for codes they know and treat the prose as a debug hint — a peer must not compose
   another server's UI.
6. **`404` means "try again"; `410` means the relationship is over** — tear down locally
   (members leave the mirror, origins stop pushing) instead of retrying forever. Members
   announce their own departure with `POST /albums/:mappingId/leave`, best-effort.
7. **`checksum` is an origin-supplied opaque identity**, not an integrity check: nothing
   verifies it against bytes, only equality is ever used (dedup and loop prevention).
   `checksumAlg` names the algorithm (absent = `sha1-b64`); an unrecognised algorithm makes a
   ref opaque-but-usable, and a mixed-algorithm mesh duplicates rather than errors.
8. **Byte requests**: the `range` header field is a single HTTP byte-range forwarded verbatim
   (no multipart ranges, no validators — there are no ETags). The optional `mapping` field is
   advisory in protocol 2; a future major may enforce it. A stream reset mid-body is a legal
   cancellation, not an error to penalise. Receivers cap what they will buffer from a byte
   stream even when they asked for a bounded range.
9. **Reserved frame-header keys**: `flags` (request and response) and `encoding` (response)
   are reserved for future use and currently absent.
