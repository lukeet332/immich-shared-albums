# Architecture

One process, five loops, one SQLite file. Everything user-facing is either the
stock Immich app rendering ordinary data we planted, or a web page we serve.

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
            │  SQLite: peers, mappings, refs, seen-sums   │
            │                                             │
            │  web: panel (/sidecar/) · banner (/share/*) │
            │       originals proxy (/api/assets/*/orig.) │
            └─────────────────────────────────────────────┘
```

## Components

- **watcher** — polls mapped albums via the Immich API; detects additions
  (→ register refs with peers) and removals; detects proxy assets appearing in
  *users' own albums* (→ save-to-library swap). Records everything it has done
  in `seen` so polls are idempotent and loops are impossible.
- **protocol client/server** — signed ref exchange between households.
  Key pinned at redemption (anchored on the share key). URLs are hints;
  identity is the key.
- **materialiser** — makes shared state look like ordinary Immich data:
  creates mirror albums (name template), utility users per contributor,
  ingests previews as proxy assets, unwinds them when refs die.
- **web** — the panel (households, links, joins, removals), the share-page
  banner, the optional originals proxy. All fail open.
- **reconciler** — periodic manifest sweep against each peer; prunes ghosts,
  heals missed updates. No webhooks by design: eventual consistency measured
  in minutes is correct for family albums.

## Iron rules

1. Stock Immich is never modified; all cleverness lives at the reverse proxy
   or behind the public API.
2. Every injected surface fails open — Immich must work perfectly with the
   sidecar dead.
3. The app only ever touches its own server's ordinary data.
4. Originals leave their origin only for save-to-library or the originals
   proxy — never stored on another household's disk without a user's save.
5. Default-closed: no uninvited server can reach anything.
