# `web/` — HTTP surface

The single process's one HTTP entry point and the HTML it serves.

| File | What it does |
|---|---|
| `server.ts` | The router: a thin dispatch table mapping each path to a handler. Exports `server`; `index.ts` calls `.listen()`. |
| `passthrough.ts` | The transparent fall-through proxy to Immich for anything that isn't a sidecar route (share pages, SPA bundles, `/api`), with join-banner injection on `/share/*` HTML. Streams both directions — uploads must never be buffered here. |
| `upgrade.ts` | Websockets and any other protocol upgrade, piped at the socket level. Separate from `passthrough.ts` because `fetch()` cannot carry an upgrade at all: these never reach the router, arriving on the server's `upgrade` event instead. Two transports, two files. |
| `banner.ts` | Loads `banner/banner.js` once — it's both served at `/immich-shared-albums/banner.js` and injected by `passthrough.ts`. |
| `frontend.ts` | The one table of human-facing surfaces — what pages and scripts exist, and who may see them. Answering that should not require tracing `server.ts`. Served *before* the body cap, since none of them has a body. |
| `panel/` | The admin panel as a Preact TSX app, bundled by esbuild to `panel.bundle.js` (committed, so the Dockerfile needs no build step). Client-rendered: it is admin-only and every action it offers was already a JSON call. |
| `accept/` | The joining page, same shape, its own bundle so the public page carries no admin code. `#who`, `#go`, `#out` and `#openapp` are a **test contract** — the browser lane drives the page through them. |
| `tags.ts` | `html`/`css` template tags for the server-rendered pages. Two jobs: Prettier formats embedded HTML/CSS only inside tagged literals, and `html` **escapes every interpolation** — peer names arrive from a remote server and are rendered into a page holding an admin session. |
| `pages.ts` | The two HTML shells, `PANEL_SHELL` and `ACCEPT_SHELL` — markup and mount points only; both UIs are the Preact apps in `panel/` and `accept/`. The joining flow turns a share link into a join (detects sign-in, prompts for an album password when the origin asks, then deeplinks into the app once the album has filled). |
| `auth.ts` | Who is calling a human-facing route. Forwards the caller's own Immich credentials (session cookie or API key) to Immich's `/users/me` and believes the answer. The sidecar has no accounts of its own and must never invent any. |
| `banner/` | `banner.js` — injected into an origin's `/share/*` page so a visitor can type their own server address and join. `preview.html` is a local harness for iterating on it. |

## Who may call what

Every route here can be published to the internet, so reachability is never permission.
There are three tiers, and each is enforced server-side:

| Tier | Routes | Gate |
|---|---|---|
| Public | `/immich-shared-albums/health`, `/immich-shared-albums/banner.js`, `/immich-shared-albums/accept` | none — liveness, a script, and a static page. `health` returns `{ok:true}` and nothing else, because the banner probes it cross-origin to discover a sidecar. |
| Signed-in human | `/immich-shared-albums/join`, `/leave`, `/peers`, `/pairings`, `/pairings/revoke`, `/pair`, `/unlink`, the panel | `auth.ts` against the caller's Immich session. `join` takes the account from the **session**, not the request body; naming a different user requires admin. Everything else here — `leave`, `peers`, all three pairing routes, `unlink`, the panel — requires admin, because a server link is an admin-owned object. |
| Peer | everything under `/immich-shared-albums/api/v1/*` | ed25519 signature (`peers.callingPeer`) **and**, for byte routes, entitlement (`p2p/entitlement`). |

The accept page's client-side `whoami` is UX only — it tells someone to sign in before
they fill a form. The server never trusts it.

**Two ordering rules in `server.ts`:** route before reading a body (only the sidecar's own
JSON routes are buffered, under `MAX_BODY_KB`; passthrough traffic including photo uploads
streams through), and authorise before doing work.

## Two deployment shapes

**Single front (simplest to install).** Point the reverse proxy at the sidecar and let it
pass everything else through to Immich — one route, no path matching, no ordering to get
wrong. Keep Immich as a second upstream so a dead sidecar fails open:

```caddy
photos.example.com {
	reverse_proxy immich-shared:8300 immich-server:2283 {
		lb_policy first
		fail_duration 10s
	}
}
```

This is the shape the demo rig uses — the phones sign in to the sidecar's origin, because
that is where the byte interceptors live. It also removes every same-origin question at a
stroke: banner injection, byte interception and the accept page's session cookie all just
work, because there genuinely is one origin.

**Path-routed (Immich stays the front).** Route only `/immich-shared-albums/*`, `/share/*` and the three
GET byte paths to the sidecar, ahead of the catch-all. More proxy config, and the ordering
matters, but Immich's traffic never traverses the sidecar. See [deploy/](../../deploy/).

## Protocol upgrades bypass the router

WebSocket upgrades never reach the request router — see `upgrade.ts`. Without carrying them, this
addon cannot front Immich on its own, because Immich's live web updates break.

## The ordering in `server.ts` is a contract

Every route here may be published to the internet, so two rules hold throughout, and the order of
the checks is what enforces them.

**Route before reading a body.** Only this addon's own JSON routes are buffered, under a hard cap.
Passthrough traffic — which includes photo uploads — streams straight through. Buffering first would
let any caller size the process's memory.

Oversize input is **drained, not buffered**: memory stays O(1) while the socket survives long enough
for the caller to actually receive the 413. Destroying the request instead resets the connection and
the client sees a network error rather than an answer. Cutting the upload off at the wire is the
reverse proxy's job — see the `request_body` cap in `deploy/Caddyfile.snippet`.

**Reaching a route is never permission to use it.** Human routes authenticate against the caller's
own Immich session (`auth.ts`); peer routes authenticate by signature **and** check entitlement
(`p2p/entitlement.ts`).

The sequence, which must not be rearranged:

1. **Peer avatar read** — signed like every other peer route. A bare public key is not a
   credential; it is published in every redeem and pair response.
2. **Human-facing surfaces** (`frontend.ts`) — served before the body cap, since none has a body.
3. **Byte interceptors** — the app's own asset URLs, served with true bytes streamed live from the
   owner for proxy assets. These must come before the passthrough or Immich answers them itself.
4. **Passthrough** — the catch-all transparent proxy, banner-injected on `/share` pages, streaming
   both directions.

## Why the bundles are read through their own module

`panel-bundle.ts` exists so `server.ts` does not do file IO inline, and so a missing bundle fails
loudly: a blank panel deserves an explicit error at startup rather than a 404 that looks like a
routing bug.

## The joining page's element ids are a test contract

`#who`, `#go`, `#out` and `#openapp` exist because the Playwright lane in
`demo/e2e/browser-test.mjs` drives the page through them. Converting that page to components
replaced them with class names, and the browser tests failed while the 141-check API suite stayed
green — that lane is the only coverage of this flow end to end, so those ids are not decoration.
