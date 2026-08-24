# `web/` — HTTP surface

The single process's one HTTP entry point and the HTML it serves — for humans and the stock app only; peer traffic rides iroh (`p2p/`).

| File | What it does |
|---|---|
| `server.ts` | The router: a thin dispatch table mapping each path to a handler. Exports `server`; `index.ts` calls `.listen()`. |
| `passthrough.ts` | The transparent fall-through proxy to Immich for anything that isn't a sidecar route (SPA bundles, `/api`, `?native=1` share pages). Pure stream both directions — it buffers and rewrites nothing; uploads must never be buffered here. |
| `upgrade.ts` | Websockets and any other protocol upgrade, piped at the socket level. Separate from `passthrough.ts` because `fetch()` cannot carry an upgrade at all: these never reach the router, arriving on the server's `upgrade` event instead. Two transports, two files. |
| `assets.ts` | Reads the committed `dist/` artifacts once, rewrites the route prefix, and fills each document's `%%TOKENS%%` with escaped per-request values (household name, og tags, the sign-in reason). The only server-side code that touches HTML, and it contains none. |
| `ui/` | The whole front-end, one Preact workspace: `lib/Document.tsx` (the single document every page prerenders into), `lib/theme.ts`, and `pages/{panel,accept,share,sign-in}` — each page is TSX components plus a real `.css` file. `scripts/build-web.mjs` bundles and prerenders it into `dist/`. |
| `dist/` | Committed build output — `<page>.js`, `<page>.css`, prerendered `<page>.html`. Committed so the Dockerfile stays seven lines with no build step; the pre-commit hook rebuilds and stages it, and CI fails on drift. |
| `auth.ts` | Who is calling a human-facing route. Forwards the caller's own Immich credentials (session cookie or API key) to Immich's `/users/me` and believes the answer. The sidecar has no accounts of its own and must never invent any. |


## Who may call what

Every route here can be published to the internet, so reachability is never permission.
There are three tiers, and each is enforced server-side:

| Tier | Routes | Gate |
|---|---|---|
| Public | `/immich-shared-albums/health`, `/immich-shared-albums/accept`, `/immich-shared-albums/assets/*`, `/share/:key` (the join document; `?native=1` passes through) | none — liveness, static pages and their assets. `health` returns `{ok:true}` and nothing else, because the join card probes it cross-origin to discover a sidecar. |
| Signed-in human | `/immich-shared-albums/join`, `/leave`, `/peers`, `/pairings`, `/pairings/revoke`, `/pair`, `/settings`, `/unlink`, the panel | `auth.ts` against the caller's Immich session. `join` takes the account from the **session**, not the request body; naming a different user requires admin. Everything else here requires admin — server links and settings are admin-owned objects. |
| Peers | **nothing** — peer operations left HTTP entirely and ride mutually authenticated iroh QUIC; see [`../p2p/wire-protocol.md`](../p2p/wire-protocol.md). The router serves humans and the app, full stop. |

The accept page's client-side `whoami` is UX only — it tells someone to sign in before
they fill a form. The server never trusts it.

**Two ordering rules in `server.ts`:** route before reading a body (only the sidecar's own
JSON routes are buffered, under `MAX_BODY_KB`; passthrough traffic including photo uploads
streams through), and authorise before doing work.

## The share document, and the switch that governs it

`GET /share/:key` serves the prerendered share document: `og:` tags for link unfurlers, the
origin's **endpoint token** (so a visitor's sidecar can dial it over iroh), and the join card
over the native album in a same-origin iframe. `?native=1` is the untouched Immich page — what
the iframe loads, and where dismissing the card navigates.

The panel's Settings switch (`shareLinkJoin` in the kv `settings` row, default on) governs the
whole capability: off means every `/share/*` request passes straight through **and** the iroh
`/invites/redeem` route answers 403 (`p2p/routes.ts`) — hiding the card without refusing the
join would be a setting that lies.

The element ids `#who`, `#go`, `#out`, `#openapp` and the join card's `#immich-shared-albums-banner .card`/`input`/`button.join`/`.err` are a **test contract**: the browser lane drives
both pages through them, and it is the only end-to-end coverage those flows have.

## Two deployment shapes

**Single front (simplest to install).** Point the reverse proxy at the sidecar and let it
pass everything else through to Immich — one route, no path matching, no ordering to get
wrong. Keep Immich as a second upstream so a dead sidecar fails open:

```caddy
photos.example.com {
	reverse_proxy immich-shared-albums:8300 immich-server:2283 {
		lb_policy first
		fail_duration 10s
	}
}
```

This is the shape the demo rig uses — the phones sign in to the sidecar's origin, because
that is where the byte interceptors live. It also removes every same-origin question at a
stroke: the share document, byte interception and the accept page's session cookie all just
work, because there genuinely is one origin.

**Path-routed (Immich stays the front).** Route only `/immich-shared-albums/*`, `/share/*` and the three
GET byte paths to the sidecar, ahead of the catch-all. More proxy config, and the ordering
matters, but Immich's traffic never traverses the sidecar. See [deploy/](../../deploy/).
