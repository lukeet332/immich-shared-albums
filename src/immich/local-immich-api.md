# `immich/` — the local Immich layer

Everything that reads from or writes to **this household's own Immich** lives here.
Nothing in this folder knows about peers or the wire protocol — it only speaks the
Immich REST API. Higher layers (`p2p/`, `sync/`) compose these functions.

| File | What it does |
|---|---|
| `client.ts` | The Immich REST client: the `fetch` wrapper (`immich`/`immichJson`), the 60s-cached users map, album/asset getters (v3 uses `search/metadata`, not embedded album assets), asset upload, metadata apply, and the 1×1 `STUB_JPEG` placeholder. |
| `refs.ts` | The on-the-wire shape of a shared photo (`AssetRef`). `assetToRef` describes a local asset for a peer; `offerableAssets` is the full set an album may advertise (what manifests use); `shareableAssets` is that minus what a mapping has already sent (the push queue); `buildManifest` renders the offer set. |
| `contributors.ts` | Per-contributor **utility users** (`shared-*@sidecar.local`). Foreign photos are owned by these bot users so they stay out of the local timeline while keeping attribution. Provisions/heals them, mints their API keys (toggling password-login if the instance is OAuth-only), and syncs avatars. |
| `materialise.ts` | Writing and un-writing **proxy assets**. `materialiseRef` pulls a ~2 KB stub (or a playable video prefix) and files it under the right contributor; `deleteProxyAsset` removes one — hard-guarded so only utility-owned proxies are ever deletable. Human photos are untouchable. |

**Key idea — the hotlink model:** a materialised asset is only a placeholder stub. The
real pixels never live here; they stream from the owner's server on demand (see `media/`).
