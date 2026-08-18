# `web/` — HTTP surface

The single process's one HTTP entry point and the HTML it serves.

| File | What it does |
|---|---|
| `server.ts` | The router: a thin dispatch table mapping each path to a handler. Exports `server`; `index.ts` calls `.listen()`. |
| `passthrough.ts` | The transparent fall-through proxy to Immich for anything that isn't a sidecar route (share pages, SPA bundles, `/api`), with join-banner injection on `/share/*` HTML. Websocket upgrades are refused cleanly. |
| `banner.ts` | Loads `banner/banner.js` once — it's both served at `/sidecar/banner.js` and injected by `passthrough.ts`. |
| `pages.ts` | The two HTML surfaces: the admin **PANEL** (join box + status) and the **ACCEPT_PAGE** that turns a share link into a join (detects sign-in, prompts for an album password when the origin asks, then deeplinks into the app once the album has filled). |
| `auth.ts` | Who is calling a human-facing route. Forwards the caller's own Immich credentials (session cookie or API key) to Immich's `/users/me` and believes the answer. The sidecar has no accounts of its own and must never invent any. |
| `banner/` | `banner.js` — injected into an origin's `/share/*` page so a visitor can type their own server address and join. `preview.html` is a local harness for iterating on it. |

## Who may call what

Every route here can be published to the internet, so reachability is never permission.
There are three tiers, and each is enforced server-side:

| Tier | Routes | Gate |
|---|---|---|
| Public | `/sidecar/health`, `/sidecar/banner.js`, `/sidecar/accept` | none — liveness, a script, and a static page. `health` returns `{ok:true}` and nothing else, because the banner probes it cross-origin to discover a sidecar. |
| Signed-in human | `/sidecar/join`, `/sidecar/leave`, the panel | `auth.ts` against the caller's Immich session. `join` takes the account from the **session**, not the request body; naming a different user requires admin. `leave` and the panel require admin. |
| Peer | everything under `/sidecar/api/v1/*` | ed25519 signature (`peers.callingPeer`) **and**, for byte routes, entitlement (`p2p/entitlement`). |

The accept page's client-side `whoami` is UX only — it tells someone to sign in before
they fill a form. The server never trusts it.

**Two ordering rules in `server.ts`:** route before reading a body (only the sidecar's own
JSON routes are buffered, under `MAX_BODY_KB`; passthrough traffic including photo uploads
streams through), and authorise before doing work.

**On the byte interceptors:** in production a reverse proxy (Caddy) usually routes the byte
paths straight to the sidecar; when the sidecar fronts Immich directly (demo/simple setups)
the fall-through proxy keeps the whole Immich SPA working, websockets excepted.
