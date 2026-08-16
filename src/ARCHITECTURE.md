# Architecture

One zero-dependency Node process — TypeScript run natively by Node's type
stripping (no build step), state in SQLite via the built-in node:sqlite (WAL,
crash-safe, indexed ledgers; a legacy state.json migrates automatically on
boot). Three loops: watcher, reconciler, comment sync. Everything user-facing
is either the stock Immich app rendering ordinary data we planted, or a web
page we serve.

```
            ┌─────────────────────────────────────────────┐
            │                  sidecar                     │
            │                                             │
 Immich API │  watcher ──► protocol client ──► peers      │  signed HTTPS
 (API key)  │     ▲                              │        │  to other
 ◄──────────┤     │                              ▼        │  households
            │  materialiser ◄── inbound refs ── server    │◄──────────────
            │     │                                       │
            │     ▼                                       │
            │  state.db (SQLite): keys, peers, mappings,  │
            │        seen ledger, activity, contributors  │
            │                                             │
            │  web: panel (/sidecar/) · banner (/share/*) │
            │       accept page (/sidecar/accept)         │
            └─────────────────────────────────────────────┘
```

## Components

- **watcher** — polls mapped albums via the Immich API, but first does a
  version handshake against the album's `updatedAt` and skips untouched
  albums entirely (an idle album costs one row read per cycle). Fresh
  additions are pushed to peers as refs (partial-success protocol: failed
  refs are re-offered next cycle). Everything is recorded in `seen`, keyed
  per album mapping, and each proxy's ledger entry records the SOURCE photo's
  checksum and origin asset — so the ledger doubles as provenance: the origin
  relays member contributions onward to the other member households, and
  provably never offers a household its own photos back.
- **reconciler** — members ask the origin for the album's version
  (`GET .../version`, one cheap read) and only pull the full manifest
  (`GET .../manifest`) on mismatch, materialising anything missing — heals
  refs missed at join time. No webhooks by design: eventual consistency
  measured in seconds-to-minutes is correct for family albums.
- **comment sync** — two-way; locally-authored comments are pushed, peer
  comments are posted via the author's utility user, and a seen-ledger keyed
  both directions prevents echo loops.
- **protocol client/server** — signed ref exchange between households.
  Key pinned at redemption (anchored on the share key). URLs are hints;
  identity is the key.
- **materialiser** — makes shared state look like ordinary Immich data:
  mirror albums owned by a utility user named after the origin's album owner
  ("Jane (via shared albums)"), one utility user per contributor (with their
  real avatar synced across), preview-grade renditions ingested as proxies
  (images: 1440px preview; videos: the playable transcode) with capture date,
  GPS, and an uploader credit re-applied. Originals are never stored — the
  ledger remembers which origin asset each proxy stands for.
- **originals proxy** — intercepts the app's own download URL
  (`/api/assets/:id/original`). For a proxy asset it authorises the caller
  against Immich with their own credentials, then STREAMS the true original
  live from the owner's server (chaining through the origin for relayed
  photos: D <- origin <- contributor). Falls through to Immich for everything
  else and on any failure. Streaming, never buffering — Pi-friendly.
- **membership = visibility** — mirrors are owned by utility users, so only
  album members see them. Joins are per-user: the accept page reads the
  visitor's own Immich session and adds exactly that account; a second user
  joining the same link is added to the existing mirror.
- **web** — the panel, the share-page join banner (shadow-DOM, fails silent),
  the accept page, and a transparent proxy for share-page SPA assets when the
  sidecar fronts Immich directly. All fail open.

Planned, not yet in v0: save-to-library (the explicit per-photo opt-in that
stores a true original owned by the saving user), ref removal propagation,
change-nudge webhooks (origin pings members on change; polling remains the
fallback).

Migration note: proxies materialised before the provenance ledger have no
origin link — they stay as-is and are excluded from relay and on-demand
originals; only newly synced photos participate.

## Iron rules

1. Stock Immich is never modified; all cleverness lives at the reverse proxy
   or behind the public API.
2. Every injected surface fails open — Immich must work perfectly with the
   sidecar dead.
3. The app only ever touches its own server's ordinary data.
4. Ownership stays with the photo's taker: other households store only
   preview-grade renditions; originals stream on demand and are only ever
   STORED elsewhere when a user explicitly saves a photo to their own
   library.
5. Default-closed: no uninvited server can reach anything.
