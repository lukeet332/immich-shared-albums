# `immich/` — the local Immich layer

Everything that reads from or writes to **this household's own Immich** lives here.
Nothing in this folder knows about peers or the wire protocol — it only speaks the
Immich REST API. Higher layers (`p2p/`, `sync/`) compose these functions.

| File | What it does |
|---|---|
| `client.ts` | The Immich REST client: the `fetch` wrapper (`immich`/`immichJson`), the 60s-cached users map, album/asset getters (v3 uses `search/metadata`, not embedded album assets), asset upload, metadata apply, and the 1×1 `STUB_JPEG` placeholder. |
| `refs.ts` | The on-the-wire shape of a shared photo (`AssetRef`). `assetToRef` describes a local asset for a peer; `offerableAssets` is the full set an album may advertise (what manifests use); `shareableAssets` is that minus what a mapping has already sent (the push queue); `buildManifest` renders the offer set. |
| `contributors.ts` | Per-contributor **utility users** (`shared-*@immich-shared-albums.local`; invite targets are `invite-*` on the same domain). Foreign photos are owned by these bot users so they stay out of the local timeline while keeping attribution. Provisions/heals them, mints their API keys (toggling password-login if the instance is OAuth-only), and syncs avatars. See the note below — these are the sidecar's most sensitive artefacts. |
| `materialise.ts` | Writing and un-writing **proxy assets**. `materialiseRef` pulls a ~2 KB stub (or a playable video prefix) and files it under the right contributor; `deleteProxyAsset` removes one — hard-guarded so only utility-owned proxies are ever deletable. Human photos are untouchable. |

**Key idea — the hotlink model:** a materialised asset is only a placeholder stub. The
real pixels never live here; they stream from the owner's server on demand (see `media/`).

## Utility users are real accounts — keep them boring

`contributors.ts` creates genuine Immich users on your server. That makes them the most
sensitive thing the sidecar writes, and three properties keep them contained:

- **Never admins.** They own stubs and curate mirror albums; nothing they do needs
  `/admin/*`, so an escaped key cannot reach it.
- **A scoped key, not `all`.** `UTILITY_PERMISSIONS` lists exactly the actions the sidecar
  exercises. `all` was never admin-equivalent for a non-admin user, but it did grant every
  action that user could take, on a credential stored in `state.db`.
- **No retained password.** A password exists only long enough to mint the API key — Immich
  has no way for an admin to mint one on another user's behalf — and is then rolled to a
  value the sidecar never keeps. So these accounts cannot be signed into at all, and the
  only credential in `state.db` is a scoped key. If the roll fails the password is kept so
  a retry can resume, and the failure is logged.

`UTILITY_QUOTA_MB` optionally caps their storage. Size it well above the shared volume:
too low and materialisation starts failing silently.
