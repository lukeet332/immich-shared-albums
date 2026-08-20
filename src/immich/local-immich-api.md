# `immich/` — the local Immich layer

Everything that reads from or writes to **this household's own Immich** lives here.
Nothing in this folder knows about peers or the wire protocol — it only speaks the
Immich REST API. Higher layers (`p2p/`, `sync/`) compose these functions.

| File | What it does |
|---|---|
| `client.ts` | The Immich REST client: the `fetch` wrapper (`immich`/`immichJson`), the 60s-cached users map, album/asset getters (v3 uses `search/metadata`, not embedded album assets), asset upload, metadata apply, and the 1×1 `STUB_JPEG` placeholder. |
| `refs.ts` | The on-the-wire shape of a shared photo (`AssetRef`). `assetToRef` describes a local asset for a peer; `everythingOfferable` is the full set an album may advertise (what manifests use); `notYetSentTo` is that minus what a mapping has already sent (the push queue); `buildManifest` renders the offer set. |
| `contributors.ts` | **One local account per remote person** (`person-<their user id>@immich-shared-albums.local`; `shared-*` remains for non-person helpers). Foreign photos are owned by these accounts so they stay out of local timelines while keeping attribution, and the same account is what a human picks in Immich's album picker to share with that person. Provisions/heals them, mints their API keys (toggling password-login if the instance is OAuth-only), and syncs avatars. See the note below — these are the sidecar's most sensitive artefacts. |
| `materialise.ts` | Writing and un-writing **proxy assets**. `tryMaterialiseRef` pulls a ~2 KB stub (or a playable video prefix) and files it under the right contributor; `deleteProxyAsset` removes one — hard-guarded so only utility-owned proxies are ever deletable. Human photos are untouchable. |

**Key idea — the hotlink model:** a materialised asset is only a placeholder stub. The
real pixels never live here; they stream from the owner's server on demand (see `media/`).

## Utility users are real accounts — keep them boring

`contributors.ts` creates genuine Immich users on your server. That makes them the most
sensitive thing the sidecar writes, and three properties keep them contained:

- **Never admins.** They own stubs and curate mirror albums; nothing they do needs
  `/admin/*`, so an escaped key cannot reach it.
- **A scoped key, not `all`.** `ACCOUNT_PERMISSIONS` lists exactly the actions the sidecar
  exercises. `all` was never admin-equivalent for a non-admin user, but it did grant every
  action that user could take, on a credential stored in `state.db`.
- **No retained password.** A password exists only long enough to mint the API key — Immich
  has no way for an admin to mint one on another user's behalf — and is then rolled to a
  value the sidecar never keeps. So these accounts cannot be signed into at all, and the
  only credential in `state.db` is a scoped key. If the roll fails the password is kept so
  a retry can resume, and the failure is logged.

`UTILITY_QUOTA_MB` optionally caps their storage. Size it well above the shared volume:
too low and materialisation starts failing silently.

## Immich behaviours this folder exists to absorb

- **v3 removed embedded assets from the album endpoint.** `search/metadata` is the stable
  enumerator, and it pages — `getAlbumAssets` walks it.
- **Immich dedupes identical bytes per user.** Every proxy must stay a distinct asset, so each stub
  gets a random tail appended to the minimal 1x1 JPEG.
- **A proxy's wire identity is its SOURCE checksum**, not the local file's. The local file is a
  re-encoded preview; the ledger keeps the original checksum so that is what travels between
  servers and the per-mapping seen-ledger stays meaningful across hops.
- **Provenance survives mirroring.** For utility-owned proxies (relayed photos) the true
  contributor is recovered from the account's display name, and the "Shared by" credit line this
  addon appends locally is stripped first — otherwise downstream hops stack it twice.
