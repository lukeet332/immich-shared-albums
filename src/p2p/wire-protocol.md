# `p2p/` — the cross-server wire protocol

How two sidecars introduce themselves and move album state between servers. Transport
primitives (signing, the signed POST, nudges) live one level up in `../peers.ts`; this
folder is the **application** protocol on top of them.

| File | What it does |
|---|---|
| `protocol.ts` | Inbound handlers, mostly owner-side. `handleRedeem` turns a share link into a pinned peer + mapping and returns the manifest; `handleRefs` accepts pushed photos; `handleVersion`/`handleManifest` answer the cheap handshake and the full offer set; `handleNudge` reacts to "something moved, pull now". Each returns `[statusCode, jsonBody]` for the router. |
| `join.ts` | The **member side** of joining. Redeems a share link against the origin, pins the peer, provisions the host utility user, creates the local mirror album, adds the joining user, and kicks off the first reconcile. Idempotent — re-joining just adds the user to the existing mirror. |
| `entitlement.ts` | What a peer may **read**, as distinct from who it is. Records every asset advertised to a mapping, and answers the byte routes' "is this peer allowed this asset". |

**The handshake, end to end:** the banner (`../web/banner/`) collects the joiner's own
server address → their sidecar calls `join()` → which POSTs `handleRedeem` on the origin
→ the origin pins the peer and returns a manifest → the joiner materialises it via
`sync/`. Every request is signed with the household ed25519 key; the origin is always the
source of truth for the album.

## What a signature does and does not prove

A signature proves **which peer is calling**. On its own it says nothing about what that
peer may touch, and treating the two as the same thing is how a peer-to-peer protocol
turns into an open door. Three rules follow, and every inbound handler keeps them:

1. **Identify with the key, never match on it.** `peers.callingPeer` requires a valid
   signature; a bare `x-isa-key` header is not a credential, because every public key is
   published in redeem responses.
2. **Look mappings up *with* the caller.** `peers.mappingFor` always filters on
   `m.peer === peerPub`. Without that term a mapping id alone selects an album, and any
   enrolled peer can act on a relationship belonging to a different household.
3. **A nudge is a hint, never a source.** `handleNudge` reconciles against the mapping's
   own origin, never against whoever sent the nudge — otherwise a peer could nominate
   itself as the source of truth for someone else's album and plant content in it.

## Enrolment

`handleRedeem` is the one route that runs before a relationship exists, so it is the one
that decides who becomes a peer at all. It requires:

- **A signature over the request body, verified against the key being enrolled.** This is
  trust-on-first-use: it proves the caller holds the private half of the key it is asking
  us to trust, so the enrolled identity cannot later be forged or substituted.
- **The share link's own rules, honoured exactly as the Immich share page honours them** —
  an expired link is refused, and a password-protected link requires that password
  (constant-time compared). The origin verifies it; the joiner only relays what the user
  typed. Set `REQUIRE_SHARE_PASSWORD=true` to refuse unprotected links outright.
- **Idempotency.** Re-redeeming reuses the existing mapping rather than minting another,
  so a valid link is not an unbounded state-growth lever.

Known limitation: a share link is still a bearer credential. Anyone holding the link (and
its password) can enrol. Binding enrolment to a recipient — an owner-issued single-use
invite plus key pinning — is the intended successor to this.
