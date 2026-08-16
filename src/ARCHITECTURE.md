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

- **watcher** — polls mapped albums via the Immich API; pushes fresh
  human-owned additions to peers as refs (partial-success protocol: failed
  refs are re-offered next cycle). Records everything in `seen`, keyed per
  album mapping, so polls are idempotent; utility-owned proxies are never
  pushed, so loops are impossible.
- **reconciler** — each cycle, members re-pull the origin's manifest
  (`GET /sidecar/api/v1/albums/:mapping/manifest`, signed) and materialise
  anything missing — heals refs missed at join time (e.g. previews not yet
  generated). Manifests list only human-owned photos, so reconciliation can't
  echo a household's own photos back to it. No webhooks by design: eventual
  consistency measured in minutes is correct for family albums.
- **comment sync** — two-way; locally-authored comments are pushed, peer
  comments are posted via the author's utility user, and a seen-ledger keyed
  both directions prevents echo loops.
- **protocol client/server** — signed ref exchange between households.
  Key pinned at redemption (anchored on the share key). URLs are hints;
  identity is the key.
- **materialiser** — makes shared state look like ordinary Immich data:
  mirror albums owned by a utility user named after the origin's album owner
  ("Jane (via shared albums)"), one utility user per contributor (with their
  real avatar synced across), previews ingested as proxy assets with capture
  date, GPS, and an uploader credit in the description.
- **membership = visibility** — mirrors are owned by utility users, so only
  album members see them. Joins are per-user: the accept page reads the
  visitor's own Immich session and adds exactly that account; a second user
  joining the same link is added to the existing mirror.
- **web** — the panel, the share-page join banner (shadow-DOM, fails silent),
  the accept page, and a transparent proxy for share-page SPA assets when the
  sidecar fronts Immich directly. All fail open.

Planned, not yet in v0: save-to-library original swap, originals proxy
(full-quality in-app viewing), video refs, ref removal propagation,
member→member relay in three-plus-household albums.

## Iron rules

1. Stock Immich is never modified; all cleverness lives at the reverse proxy
   or behind the public API.
2. Every injected surface fails open — Immich must work perfectly with the
   sidecar dead.
3. The app only ever touches its own server's ordinary data.
4. Originals leave their origin only for save-to-library or the originals
   proxy — never stored on another household's disk without a user's save.
5. Default-closed: no uninvited server can reach anything.
