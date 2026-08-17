# `media/` — the hotlink byte path

Where the actual pixels come from. Mirrors store only kilobyte stubs; when a device
asks for a thumbnail, preview, original or video, these modules fetch the **real bytes
live from the owner's server** (chained through the origin for relayed photos).

| File | What it does |
|---|---|
| `proxy.ts` | `fetchTrueBytes` resolves an asset's true pixels: a local file for our own photos, or a signed chained fetch to the owner's server for a proxy (how a relayed photo streams `D <- origin <- contributor`). `Range` passes through for seekable video. `handlePreview`/`handleOriginal`/`handlePlayback` are the peer-facing endpoints. |
| `interceptor.ts` | The **app-facing** side: intercepts the stock app's own asset URLs (`/api/assets/:id/{thumbnail,original,video/playback}`) and, for a proxy asset, serves true bytes (previews via the LRU cache) — falling through to Immich's stub on any failure. Called by the web router. |
| `cache.ts` | A bounded **LRU byte-cache** for streamed previews. Files live under `<dataDir>/cache` with accounting in SQLite. It is a *cache, not storage* — capped (`CACHE_MAX_MB`, default 512), reclaimable, and safe to delete any time. Repeat views skip the cross-server fetch; recently-viewed photos survive owner downtime. |

**Fail-open:** if the owner's server is unreachable and nothing is cached, the interceptor
falls back to the local stub (a placeholder tile) rather than erroring — the app keeps working.
