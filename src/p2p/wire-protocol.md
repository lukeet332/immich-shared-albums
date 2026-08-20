# `p2p/` — the cross-server wire protocol

How two sidecars introduce themselves and move album state between servers. Transport
primitives (signing, the signed POST, nudges) live one level up in `../peers.ts`; this
folder is the **application** protocol on top of them.

| File | What it does |
|---|---|
| `protocol.ts` | Inbound handlers, mostly owner-side. `handleRedeem` turns a share link into a pinned peer + mapping and returns the manifest; `handleRefs` accepts pushed photos; `handleVersion`/`handleManifest` answer the cheap handshake and the full offer set; `handleNudge` reacts to "something moved, pull now". Each returns `[statusCode, jsonBody]` for the router. |
| `join.ts` | The **member side** of joining. Redeems a share link against the origin, pins the peer, provisions the host utility user, creates the local mirror album, adds the joining user, and kicks off the first reconcile. Idempotent — re-joining just adds the user to the existing mirror. |
| `mirror.ts` | Creating the local mirror of a remote album — the utility-user owner, local members as editors, the mapping, and the background fill. Shared by `join.ts` (share link) and `sync/invites.ts` (native invitation): two ways to acquire an album, one way to mirror it. |
| `pair.ts` | Linking two servers as its own act, replacing bearer-based enrolment. Mints a single-use, 15-minute, 32-byte code (the secret rides in the URL **fragment**, not the path), and `handlePair` burns it *before* answering so a replay finds nothing. Signature-bound to the key being enrolled, so the identity cannot be substituted. Pairing conveys **no album access** — what the two servers may see of each other is decided afterwards, per person, in Immich's own picker. |
| `entitlement.ts` | What a peer may **read**, as distinct from who it is. Records every asset advertised to a mapping, and answers the byte routes' "is this peer allowed this asset". |
| `unlink.ts` | Cutting a server link, from the panel. Tears down mirrors held from that peer (via `sync/leave.ts`, so their stubs go too), drops the mappings and entitlement for albums shared *to* them, and deletes their per-person invite markers so they leave Immich's picker. Attribution contributors are deliberately **kept**: they own real photos that local people can see, so an unlink must never be a data-loss event. |

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

## Nudges are fire-and-forget

When an album moves, every OTHER household mapped to it is told to pull now rather than at its next
tick. A lost nudge costs nothing: the scheduled handshake catches everything regardless, so this is
fail-open by design and must never be made blocking.

## Redeem, in detail

**Trust on first use.** The redeem request is bound to the key being enrolled by a signature over
the body, which proves the caller holds the private half of the identity it asks us to trust. The
enrolled key therefore cannot be forged or substituted later.

**A share link's own rules are the owner's stated intent** and are honoured exactly as Immich's own
share page would: expiry, password, and the "allow public user to upload" switch, which becomes the
peer's contribute permission.

**Redeeming is idempotent.** Re-redeeming the same link reuses the mapping rather than minting
another; otherwise a valid link is an unbounded state-growth lever.

**The album owner comes from the share link, not the album.** v3 album responses carry no
`ownerId`, but the link records its creator — which is also who the mirror is attributed to.

**Pushed refs report partial success.** The sender re-offers only the failed refs next cycle.

## The version handshake

One cheap album read instead of a full manifest scan, so members can skip untouched albums. Note
`updatedAt` alone misses cascade deletions — removing an asset from the library does not touch the
albums containing it — so the asset count travels with the version.

## A nudge says "look again", never "look here"

It must never get to say *where* to look. Scoping the pull to the nudge's own mapping is what stops
a peer using a nudge to make this server fetch something it was never offered.

## The manifest is the reconciliation sweep

Members re-pull it every poll and materialise anything missing, which is what heals refs dropped at
join time or lost to a failed push. It lists **human-owned photos only** — proxy stubs are excluded,
so reconciliation can never echo a household's own photos back to it and have them return as
second-hand copies.

Two fields carry more weight than their types suggest. `shareKey` **is** the capability: possession
of an Immich share-link key is the entire authorisation to redeem, so it is a secret in transit, not
an identifier. `mappingId` is what the joiner quotes back on every later `refs`, `activity` and
`manifest` call, and `peers.ts` scopes each of those to the mapping's own peer — see
[`../peers.md`](../peers.md).
