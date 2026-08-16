# Changelog

Versioning: **MAJOR** = a peer on the previous version can no longer sync with you,
or upgrading requires operator action (config/env/proxy changes). **MINOR** = new
features; older peers keep working (they just miss the optimisation). **PATCH** = fixes.
Watch this repo's releases to be notified when an update breaks contract.

## v0.3.0 — 2026-08-17

- Nudge webhooks: when a contribution or comment lands on the origin, it pings the other
  member households to pull immediately — cross-server relay latency drops from
  poll-cycle seconds to ~1s. Pure hint, signed, fail-open: lost nudges are covered by
  the scheduled handshake. Old peers ignore it (additive, MINOR).
- Transparent proxy refuses websocket upgrades cleanly (426) instead of erroring per
  retry; banner pre-flight validates the typed server address (health probe with CORS),
  parses schemes case-insensitively, and no longer autocapitalises; accept page shows a
  join spinner; post-join deeplink targets the albums list (album-specific deeplinks
  race the app's sync and hang on splash).

## v0.2.1 — 2026-08-17

- Fix: a photo shared into multiple albums could echo back to its owner as a duplicate —
  deduped proxies carry ledger rows from several albums/eras, and the wire-identity
  lookup could pick a stale row; materialisation rows (true origin identity) now always
  win. New reverse-direction regression stage in the suite (54 checks).
- Fix: proxy filenames no longer break on base64 checksum characters (/ and +).

## v0.2.0 — 2026-08-17

- TypeScript throughout, run natively by Node's type stripping — still no build step
  and zero runtime dependencies; `npm run typecheck` gates CI so protocol/contract
  drift fails before the E2E suite.
- State moved from state.json to SQLite (built-in node:sqlite): crash-safe WAL,
  indexed seen-ledger lookups (scales past ~10k shared photos on low-power hosts),
  no more whole-file rewrites per synced photo. Legacy state.json migrates
  automatically on first boot (kept as state.json.migrated).
- Base image bumped to node:24-alpine. No operator action needed: same env vars,
  same volumes, same routes.
- CI hardening: mock Immich pinned by digest (upstream mutated even version tags),
  retry-wrapped registry pulls, Immich containers recycled post-migration (cold-stack
  DB pools born mid-migration mis-serialize enum arrays), weekly canary against
  :release. First published release — v0.1.0 was tagged but its release run predated
  these fixes and never published.

## v0.1.0 — 2026-08-16

First pinnable release. Working v0 validated by a 51-check end-to-end suite across
three mock households in CI.

- Reference-model sharing: preview-grade mirrors at rest, originals stream on demand
  from the owner's server (originals-proxy route), chained through the origin for
  relayed photos. Videos sync as playable renditions.
- Per-user joins (sign-in-aware accept page), idempotent re-joins, per-user privacy.
- Member→member relay through the origin with full attribution and avatars.
- Canonical comments: the origin owns the message set; two-way sync, relay, and
  backfill for late joiners, ~5s latency via a count-gated fast lane.
- Version handshake: idle albums cost one row-read per cycle.
- Share-link `allowUpload` honoured cross-server; view-only joins labelled.
- Self-healing: reconciliation, partial-success retries, cursors only advance on
  clean passes, atomic state writes.
