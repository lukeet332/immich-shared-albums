# Changelog

Versioning: **MAJOR** = a peer on the previous version can no longer sync with you,
or upgrading requires operator action (config/env/proxy changes). **MINOR** = new
features; older peers keep working (they just miss the optimisation). **PATCH** = fixes.
Watch this repo's releases to be notified when an update breaks contract.

## [0.5.0](https://github.com/lukeet332/immich-shared-albums/compare/v0.4.1...v0.5.0) (2026-08-18)


### Features

* authenticate human routes and check peer entitlement, not just identity ([42d7d86](https://github.com/lukeet332/immich-shared-albums/commit/42d7d86189fad72cc1fbd427efda83ad27f94d73))

## v0.4.1 — 2026-08-17

**Sync-reliability release: five root causes of the "mirror stops updating" flake.**

- **Manifests now advertise the album's full offer set.** They previously reused the
  push-queue filter, which excludes already-synced photos — so after first sync a
  manifest came back empty and deletion propagation had nothing to diff against
  (the consistency gate refused to act on the mismatch, so nothing was ever
  wrongly deleted — but owner deletions never reached members either).
- **Duplicate stubs fixed**: the join-time sync and the background loop could
  materialise the same photos concurrently; a per-album lock now prevents it.
- **A hung connection can no longer kill the sync loops**: every loop-critical
  fetch has a bounded timeout (a blackholed socket during a peer restart used to
  wedge the loops permanently and silently).
- **Asset deletes report success correctly** (Immich answers 204 No Content; the
  empty body was mis-read as a failure, which would have retried forever), and
  stub deletion is idempotent.
- **Bounded LRU byte-cache** for streamed previews (`CACHE_MAX_MB`, default 512):
  repeat views serve from the member's own disk; only peer-origin bytes are ever
  cached, and a photo you viewed recently still renders while its owner is offline.
- Version cursors only advance after deletion propagation succeeds, so failures
  retry instead of wedging. `RECONCILE_DEBUG=1` traces every reconcile decision.

## v0.4.0 — 2026-08-17

**The hotlink release — joining an album now costs kilobytes, not gigabytes.**

- Mirrors store ~2KB placeholder stubs (videos: a ~2MB playable prefix with real poster);
  every pixel — thumbnails, previews, originals, seekable video playback — streams live
  from the owner's server through byte interceptors, chained through the origin for
  relayed photos. Proven by an owner-kill negative control in the suite: when the owner
  is offline no hidden copy can serve, and streaming resumes the moment they return.
  Devices cache hard (immutable cache headers), so repeat views don't re-fetch.
- Deletion propagation: photos deleted at the source lose their stubs on every member
  server within a sync cycle (utility-owner-guarded — human assets are untouchable).
- Leave & purge, fully native: leave the album in the stock app (album settings ->
  Leave album) and the sidecar notices, then removes the mirror, stubs, mapping and
  ledger — joins are fully reversible, reclaim all space, and need no custom UI.
- Protocol/version advertisement in the redeem exchange: mixed-version federations log
  "update the immich-shared-albums sidecar on this server" instead of degrading silently; the panel shows peer versions.
- Browser-test lane in CI (Playwright): banner rendering, bad-address inline error,
  scheme discovery, signed-out/in accept states, async-join progress gating.
- ⚠️ Operators: update the reverse-proxy byte routes (see README — a GET-only matcher
  for /api/assets/*/{thumbnail,original,video/playback} with Immich fallback replaces
  the old originals-only route). Old routes keep working but new shared photos would
  render as placeholders until routed. During 0.x, MINOR releases may carry flagged
  operator actions like this.

## v0.3.1 — 2026-08-17

- Joins answer in ~2 seconds regardless of album size: mirror + membership are created
  up front and photos/videos stream in behind via the reconciler. The accept page shows
  live sync progress ("Syncing 3/6…") and only enables "Open in Immich app" — an
  album-specific deeplink again — once the album is actually filled.
- Two-sided demo filming rig (demo/e2e/demo-film.mjs).

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
