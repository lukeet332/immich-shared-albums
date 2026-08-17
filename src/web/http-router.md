# `web/` — HTTP surface

The single process's one HTTP entry point and the HTML it serves.

| File | What it does |
|---|---|
| `server.ts` | The router: a thin dispatch table mapping each path to a handler. Exports `server`; `index.ts` calls `.listen()`. |
| `passthrough.ts` | The transparent fall-through proxy to Immich for anything that isn't a sidecar route (share pages, SPA bundles, `/api`), with join-banner injection on `/share/*` HTML. Websocket upgrades are refused cleanly. |
| `banner.ts` | Loads `banner/banner.js` once — it's both served at `/sidecar/banner.js` and injected by `passthrough.ts`. |
| `pages.ts` | The two HTML surfaces: the admin **PANEL** (join box + status) and the **ACCEPT_PAGE** that turns a share link into a join (detects sign-in, then deeplinks into the app once the album has filled). |
| `banner/` | `banner.js` — injected into an origin's `/share/*` page so a visitor can type their own server address and join. `preview.html` is a local harness for iterating on it. |

**On the byte interceptors:** in production a reverse proxy (Caddy) usually routes the byte
paths straight to the sidecar; when the sidecar fronts Immich directly (demo/simple setups)
the fall-through proxy keeps the whole Immich SPA working, websockets excepted.
