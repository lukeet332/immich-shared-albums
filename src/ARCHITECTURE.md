# Architecture

One zero-dependency Node process, three loops (watcher, reconciler, comment
sync), one JSON state file (SQLite planned). Everything user-facing is either
the stock Immich app rendering ordinary data we planted, or a web page we serve.

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
            │  state.json: keys, peers, mappings,         │
            │              seen-sums, contributors        │
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
  per album mapping — and because copies are full originals, a proxy keeps
  its source photo's checksum, so the ledger doubles as provenance: the
  origin relays member contributions onward to the other member households,
  and provably never offers a household its own photos back.
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
  real avatar synced across), full originals ingested as owned copies —
  images and videos, real filenames, capture date, GPS, and an uploader
  credit in the description. Preview is the fallback only when an image's
  original can't be fetched.
- **membership = visibility** — mirrors are owned by utility users, so only
  album members see them. Joins are per-user: the accept page reads the
  visitor's own Immich session and adds exactly that account; a second user
  joining the same link is added to the existing mirror.
- **web** — the panel, the share-page join banner (shadow-DOM, fails silent),
  the accept page, and a transparent proxy for share-page SPA assets when the
  sidecar fronts Immich directly. All fail open.

Planned, not yet in v0: preview-only storage mode for disk-constrained
households (SYNC_QUALITY knob), ref removal propagation, change-nudge
webhooks (origin pings members on change; polling remains the fallback).

Migration note: proxies materialised before the originals era carry preview
checksums (unknown provenance) — they stay preview quality and are excluded
from relay; only newly synced photos participate.

## Iron rules

1. Stock Immich is never modified; all cleverness lives at the reverse proxy
   or behind the public API.
2. Every injected surface fails open — Immich must work perfectly with the
   sidecar dead.
3. The app only ever touches its own server's ordinary data.
4. Originals flow only to households explicitly invited to the album —
   sharing the album IS the consent; no uninvited party can fetch a byte.
5. Default-closed: no uninvited server can reach anything.
