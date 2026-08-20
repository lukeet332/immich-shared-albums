# Wire types

`types.ts` — the shapes that travel between servers, enforced at both ends by `tsc`.

## `PROTOCOL_VERSION`

The single source of truth for the wire version. It was once exported and unused while the literal
`1` sat inlined in four places — exactly the drift the naming rules warn about. Reference the
constant.

## `AssetRef` — a shared photo, described for a peer

- `originAsset` is the asset id **on the origin**; `checksum` is the sha1 of the original bytes as
  Immich computes it.
- `contributor` names a **person, not a server**, so provenance survives mirroring and relaying. It
  carries `originUserId` — that person's id on *their own* server — which is what lets one local
  account represent the same human however they are met.
- `kind` is `'image' | 'video'`; the literal union matters, because a widened `string` stopped
  `assetToRef`'s return matching this type at all.
- `takenAt` and `exif` are re-applied to the materialised proxy, so a mirrored photo sorts and maps
  like a local one.

`fileName` is deliberately absent. It used to be sent and never read on either side — dead wire
payload, removed at v1.

## `Household`

One Immich server + one instance of this addon + one keypair. `url` is a **mutable hint** — where to
reach them right now — while `publicKey` is the identity. URLs change; keys do not.
