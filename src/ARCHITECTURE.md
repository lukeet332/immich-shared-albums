# Architecture

> 🎬 The end-user experience this produces: [video demo](https://www.youtube.com/watch?v=c3GO-YFchYo).

One process, **zero JavaScript dependencies and one native one** (`@number0/iroh`, the peer
transport — lockfile-pinned, installed by the Dockerfile):

- **No build step to run it.** TypeScript is executed natively by Node's type stripping —
  `node index.ts`, Node ≥ 23.6. The front-end pages are Preact TSX bundled by esbuild, but the
  bundles are **committed**, so deploying builds nothing.
- **State is SQLite** via the built-in `node:sqlite` — WAL, crash-safe, indexed ledgers.
- **Sync is nudge-driven with a timed backstop.** A signed HTTP nudge makes the common case
  near-instant; three timers are the fail-open safety net. No websockets, no push channel to keep
  alive.
- **Everything user-facing** is either the stock Immich app rendering ordinary data we planted, or a
  page we serve.

```
            ┌─────────────────────────────────────────────┐
            │                  sidecar                    │
            │                                             │
 Immich API │  watcher ──► protocol client ──► peers      │  iroh QUIC
 (API key)  │     ▲                              │        │  dial-by-key to
 ◄──────────┤     │                              ▼        │  other households
            │  materialiser ◄── inbound refs ── server    │◄──────────────
            │     │                                       │
            │     ▼                                       │
            │  state.db (SQLite): identity, peers, mappings,  │
            │        seen ledger, activity, contributors  │
            │                                             │
            │  web: panel (/immich-shared-albums/)        │
            │       share document (/share/*) · accept   │
            └─────────────────────────────────────────────┘
```

## The three loops

Started by `index.ts`, each guarded against overlapping itself:

| Loop               | Does                                                                                       | Cadence            |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------ |
| `startWatchLoop`   | `watchOnce` pushes local additions to peers, then **ends each cycle with `reconcileOnce`** | `ISA_SYNC_POLL_MS` |
| `startCommentLoop` | two-way comment sync, gated on a cheap activity-count statistic                            | fast lane          |
| `startInviteLoop`  | `detectInvitesOnce` (origin side), then `pullInvitationsOnce` (member side)                | own tick           |

A lost nudge costs nothing — the next scheduled pass catches everything. `ISA_RECONCILE_DEBUG=1` traces
every decision.

## Components

- **watcher** — pushes what is new here out to peers.
  - Gates real work behind a version handshake on the album's `updatedAt`; an untouched album costs
    one row read per cycle.
  - Partial success: refs the peer rejected are re-offered next cycle.
  - Records every ref in `seen`, keyed per mapping, storing the **source** checksum and origin
    asset. The ledger therefore doubles as provenance: the origin relays member contributions on to
    other member households, and provably never offers a household its own photos back.
- **reconciler** — heals what the push missed.
  - Members read `GET …/version` (one cheap read) and pull `GET …/manifest` only on mismatch.
  - `updatedAt` alone misses cascade deletions — removing an asset from the library does not touch
    its albums — so the asset count travels with the version.
  - Deletion propagates: stubs whose refs leave the owner's manifest are removed, gated on a
    consistent manifest so an indexing lag never reads as a deletion.
- **comment sync** — the origin album is the source of truth. Local comments are pushed; peer
  comments are posted via **the author's own local account**, and a seen-ledger keyed in both
  directions prevents echo loops.
- **protocol client/server** — ref exchange between households over iroh: mutually authenticated
  QUIC dialing the household's key itself.
  - The key IS the address; relay/address hints refresh themselves after every dial.
  - Enrolment is proven by the connection (pairing ticket or share key names the grant).
  - Identity is _only_ identity: every mapping lookup filters on the calling peer, so a valid
    connection can never select someone else's album. See [`p2p/wire-protocol.md`](./p2p/wire-protocol.md).
- **entitlement** — "may this peer read these bytes", kept separate from "who is this peer".
  Everything advertised to a mapping (redeem response, manifest, ref push) lands in an `offered`
  index — recorded before it is advertised — and the byte routes serve exactly what is on it,
  nothing else. Removal is real revocation: assets that leave the album lose their rows. Without
  the index an asset id — which manifests hand out by design — would let any enrolled peer read
  anything the admin key can reach.
- **materialiser** — makes shared state look like ordinary Immich data.
  - Mirror albums owned by the local account standing in for the origin's album owner.
  - **One account per remote person**, keyed by their user id on their own server, so the same human
    is one account however we meet them — with their real avatar synced across.
  - Stores a **~2 KB unique stub** per photo, with capture date, GPS and uploader credit applied —
    enough for the stock app to have real rows. No pixels are stored; the ledger remembers which
    origin asset each stub stands for.
  - For a video the stub is a **playable 2 MiB prefix** of the owner's rendition
    (`Range: bytes=0-2097151`), so the tile carries a real poster and duration.
  - A stub whose ledger row has **no origin link** cannot be resolved to a source, so the byte
    routes fall through to it: such proxies are excluded from relay and on-demand originals
    (`store.ledgerWithOrigin` gates both).
  - Deletion at the source propagates, and only utility-owned assets are ever deletable. Leaving an
    album purges its stubs, mirror and ledger entirely.
- **byte interceptors** — the app's own asset URLs (`/api/assets/:id/thumbnail`, `/original`,
  `/video/playback`) intercepted for stub assets.
  - The caller is authorised against Immich with **their own** credentials first.
  - True bytes then stream live from the owner, with `Range` passthrough for seekable video,
    chaining through the origin for relayed photos (`D ← origin ← contributor`).
  - Immutable cache headers, so devices cache hard. Falls through to Immich for the user's own
    assets and on any failure — a dead sidecar degrades shared tiles, never the local library.
  - Streaming, never buffering. Pi-friendly.
- **membership = visibility** — mirrors are owned by these accounts, so only album members see them.
  Joins are per-user: the accept page reads the visitor's own session and adds exactly that account;
  a second user joining the same link is added to the existing mirror.
- **native invitations** — every person on a linked server has a local account, so adding one to an
  album in Immich's own picker shares it with **that person**, and removing them revokes it. Sharing
  never names a household.
  - Detected by listing albums _as that account_, because `GET /albums` is scoped per user and the
    admin key only ever sees the admin's own albums — which is also why link-based sharing is still
    broken for non-admins.
  - Members **pull** invitations rather than being pushed them, so a household with no inbound
    reachability still works. See [`sync/sync-loops.md`](./sync/sync-loops.md).
- **web** — the panel, the accept page, and the share document: the native share page framed under
  a join card, dismissible to the untouched `?native=1` page, toggleable from the panel's Settings.
  Plus a transparent proxy for everything else when the sidecar fronts Immich. All fail open.
- **nudges** — when the origin materialises a member's contribution or comment it pings the other
  member households (a signed POST to `…/nudge`, no payload beyond the album id) so they pull
  immediately. A latency hint, never a source of truth.

**Not built yet:** save-to-library — the explicit per-photo opt-in that stores a true original owned
by the saving user, and the one deliberate way a copy lands on your disk.

## Code layout

`index.ts` is the composition root: start the server, start the loops. Everything else is a helper.

```
src/
  index.ts            entry / composition root
  config.ts           settings (CFG), the logger, string constants
  state.ts            the store instance, household keypair, seen-ledger accessors
  store.ts            the raw SQLite layer
  peers.ts            P2P transport: sign / verify / signed POST / nudge
  types.ts            wire types shared by both ends
  invariants.test.ts  pure-logic unit tests
  immich/             the local Immich API layer        → local-immich-api.md
  p2p/                the cross-server wire protocol    → wire-protocol.md
  sync/               reconcile, comment + invite loops → sync-loops.md
  media/              the hotlink byte path + LRU cache → hotlink-bytes.md
  web/                HTTP router + pages               → http-router.md
    ui/               the front-end workspace: lib/Document.tsx + lib/theme.ts,
                      pages/{panel,accept,share,sign-in} — Preact TSX + real .css
    dist/             committed build output: <page>.js/.css + prerendered <page>.html
```

**Dependencies point downward.** Core (`config`/`state`/`peers`) depends on nothing else here;
feature folders depend on core and at most on layers below them. `p2p` and `sync` reference each
other only through runtime calls (join → reconcile, watcher → nudge), never at module load.

**A concern graduates.** It starts as one file at `src/` root (like `peers.ts`) and becomes a folder
once it needs several. Where its doc then lives, and the rule that keeps these docs accurate, are in
[AGENTS.md](../AGENTS.md) — _Where a doc lives_ and _Keep the docs in sync_.

## Iron rules

1. **Stock Immich is never modified.** All cleverness lives at the reverse proxy or behind the
   public API.
2. **Every injected surface fails open.** Immich must work perfectly with the sidecar dead.
3. **The app only ever touches its own server's ordinary data.**
4. **Ownership stays with the photo's taker.** Other households hold kilobyte placeholders; every
   pixel streams from its owner on demand, and is stored elsewhere only when a user explicitly saves
   it to their own library.
5. **Default-closed.** No uninvited server reaches anything.
6. **Reachability is never permission.** Every route assumes it is published to the open internet.
   Human routes authenticate against the caller's own Immich session; peer routes require the
   mutual-TLS connection's identity _and_ an entitlement check. Nothing is protected by being hard to find, on a private
   network, or behind a URL nobody has guessed.
7. **The sidecar invents no identities and holds no logins.** The only identity that means anything
   is an Immich one. The accounts that own stubs get a narrowly-scoped API key and no retained
   password, so they cannot be signed into at all.

**Where this falls short today:** the sidecar needs a key on an admin **account** (user CRUD is
admin-only; Immich has no service accounts), scoped to the enumerated list in
`immich/admin-key.ts` — a leaked key cannot touch photos, settings, or mint a broader key, but it
can still manage users. It also creates real user accounts — one per remote person — that appear
in every picker, for the same reason. Known costs; do not make either worse without saying so.
