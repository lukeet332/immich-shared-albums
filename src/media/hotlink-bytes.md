# `media/` — the hotlink byte path

Where the actual pixels come from. Mirrors store only kilobyte stubs; when a device
asks for a thumbnail, preview, original or video, these modules fetch the **real bytes
live from the owner's server** (chained through the origin for relayed photos).

| File | What it does |
|---|---|
| `proxy.ts` | `fetchTrueBytes` resolves an asset's true pixels: a local file for our own photos, or a chained iroh request to the owner's server for a proxy (how a relayed photo streams `D <- origin <- contributor`). `Range` rides the request frame for seekable video. `servePeerBytes` is the peer-facing side, served from the iroh route table. |
| `interceptor.ts` | The **app-facing** side: intercepts the stock app's own asset URLs (`/api/assets/:id/{thumbnail,original,video/playback}`) and, for a proxy asset, serves true bytes (previews via the LRU cache) — falling through to Immich's stub on any failure. Called by the web router. |
| `cache.ts` | A bounded **LRU byte-cache** for streamed previews. Files live under `<dataDir>/cache` with accounting in SQLite. It is a *cache, not storage* — capped (`CACHE_MAX_MB`, default 512), reclaimable, and safe to delete any time. Repeat views skip the cross-server fetch; recently-viewed photos survive owner downtime. |

**Fail-open:** if the owner's server is unreachable and nothing is cached, the interceptor
falls back to the local stub (a placeholder tile) rather than erroring — the app keeps working.

## Two different callers, two different gates

These are the only routes that hand out real pixels, and the local branch of
`fetchTrueBytes` reads with the admin key — so who is asking matters more here than
anywhere else. The two entry points authorise in completely different ways:

- **`interceptor.ts` serves the household's own app**, so it authorises with the *caller's
  own* Immich credentials: it probes `/assets/:id` with their cookie or API key and serves
  bytes only if Immich itself would have. The sidecar never grants access Immich wouldn't.
- **`proxy.ts` serves other households**, so it needs both halves: the connection's proven
  identity (mutual TLS on the household keys — the transport hands `servePeerBytes` the
  caller) *and* entitlement (`p2p/entitlement.peerMayRead`). Identity says which peer;
  entitlement says whether that peer was ever offered this asset. Identity alone would mean
  any enrolled peer could read anything in the library it could name — asset ids are not
  secrets, and manifests hand them out by design.

**Timeouts bound the handshake, not the transfer.** A hostile peer must not hold a
connection open forever, but a legitimate 4K original may stream for minutes — so the
clock stops the moment response headers arrive (`fetchWithHeaderTimeout`).
