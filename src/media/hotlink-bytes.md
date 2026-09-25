# `media/` — the hotlink byte path

Where the actual pixels come from. Mirrors store only kilobyte stubs; when a device
asks for a thumbnail, preview, original or video, these modules fetch the **real bytes
live from the owner's server** (chained through the origin for relayed photos).

With **"store shared assets locally"** on, a mirror instead holds the owner's original as a real
local asset and the ledger row carries `storedFull` — see _Stored copies_ below.

| File             | What it does                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `proxy.ts`       | `fetchTrueBytes` resolves an asset's true pixels: a local file for our own photos, or a chained iroh request to the owner's server for a proxy (how a relayed photo streams `D <- origin <- contributor`). A `storedFull` row is served from the local file — only genuine stubs chain. `Range` rides the request frame for seekable video. `servePeerBytes` is the peer-facing side, served from the iroh route table. |
| `interceptor.ts` | The **app-facing** side: intercepts the stock app's own asset URLs (`/api/assets/:id/{thumbnail,original,video/playback}`) and, for a proxy asset, serves true bytes (previews via the LRU cache) — falling through to Immich's stub on any failure. Called by the web router.                                                             |
| `cache.ts`       | A bounded **LRU byte-cache** for streamed previews. Files live under `<dataDir>/cache` with accounting in SQLite. It is a _cache, not storage_ — capped (`ISA_CACHE_MAX_MB`, default 512), reclaimable, and safe to delete any time. Repeat views skip the cross-server fetch; recently-viewed photos survive owner downtime.              |

**Fail-open:** if the owner's server is unreachable and nothing is cached, the interceptor
falls back to the local stub (a placeholder tile) rather than erroring — the app keeps working.

## Stored copies

The admin setting `storeSharedAssetsLocally` (kv row `settings`, default OFF) makes a join store
the owner's **original** instead of a stub: `upgrade_stub_to_full` fetches it over the byte path,
uploads it as an asset of the local account standing in for the contributor, and rewrites the
ledger row with `storedFull`. A bounded number of stubs upgrade per reconcile pass
(`MAX_PER_CYCLE`), which is why the manifest is pulled even while the album's version is unchanged.

A stored copy is the household's own bytes, so it outlives the share:

- Switching the setting back OFF does not revert anything: the backfill only ever upgrades, so
  copies already here keep their disk and are served from it.
- `leaveAlbum` and the origin's `handleLeave` purge only `originAsset`-bearing rows that are NOT
  `storedFull`; the copy's asset and its ledger row survive (`seenForgetProxies` keeps exactly those
  rows), so the disk the household paid for stays paid for. They are NOT re-attached by a later
  re-join: reuse is looked up per LIVE mapping of the same album (`existingCopyInAlbum`), and the
  leave is what removed that mapping, so joining again materialises a copy of its own.
- Unlinking the whole server still takes them: the copy belongs to that peer's account, and
  `force: true` deletes the account with its assets. The ledger rows follow
  (`seenForgetMapping`) — see [`../p2p/wire-protocol.md`](../p2p/wire-protocol.md).

## Two different callers, two different gates

These are the only routes that hand out real pixels, and the local branch of
`fetchTrueBytes` reads with the admin key — so who is asking matters more here than
anywhere else. The two entry points authorise in completely different ways:

- **`interceptor.ts` serves the household's own app**, so it authorises with the _caller's
  own_ Immich credentials: it probes `/assets/:id` with their cookie or API key and serves
  bytes only if Immich itself would have. The sidecar never grants access Immich wouldn't.
- **`proxy.ts` serves other households**, so it needs both halves: the connection's proven
  identity (mutual TLS on the household keys — the transport hands `servePeerBytes` the
  caller) _and_ entitlement (`p2p/entitlement.peerMayRead`). Identity says which peer;
  entitlement says whether that peer was ever offered this asset. Identity alone would mean
  any enrolled peer could read anything in the library it could name — asset ids are not
  secrets, and manifests hand them out by design.

**Streams have no read deadline, and the callers are not strangers.** A legitimate 4K
original may stream for minutes, and every byte flows over a mutually authenticated iroh
connection: an unknown key can reach only the two enrolment routes, never bytes. Memory
stays bounded regardless — request frames are length-capped (64 KB headers, `ISA_MAX_BODY_KB`
bodies) and responses stream chunk by chunk.
