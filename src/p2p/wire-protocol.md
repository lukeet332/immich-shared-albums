# `p2p/` — the cross-server wire protocol

How two sidecars introduce themselves and move album state between servers. Transport
primitives (signing, the signed POST, nudges) live one level up in `../peers.ts`; this
folder is the **application** protocol on top of them.

| File | What it does |
|---|---|
| `protocol.ts` | Inbound handlers, mostly owner-side. `handleRedeem` turns a share link into a pinned peer + mapping and returns the manifest; `handleRefs` accepts pushed photos; `handleVersion`/`handleManifest` answer the cheap handshake and the full offer set; `handleNudge` reacts to "something moved, pull now". Each returns `[statusCode, jsonBody]` for the router. |
| `join.ts` | The **member side** of joining. Redeems a share link against the origin, pins the peer, provisions the host utility user, creates the local mirror album, adds the joining user, and kicks off the first reconcile. Idempotent — re-joining just adds the user to the existing mirror. |

**The handshake, end to end:** the banner (`../web/banner/`) collects the joiner's own
server address → their sidecar calls `join()` → which POSTs `handleRedeem` on the origin
→ the origin pins the peer and returns a manifest → the joiner materialises it via
`sync/`. Every request is signed with the household ed25519 key; the origin is always the
source of truth for the album.
