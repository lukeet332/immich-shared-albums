# Changelog

Versioning: **MAJOR** = a peer on the previous version can no longer sync with you,
or upgrading requires operator action (config/env/proxy changes). **MINOR** = new
features; older peers keep working (they just miss the optimisation). **PATCH** = fixes.
Watch this repo's releases to be notified when an update breaks contract.

## [1.0.0](https://github.com/lukeet332/immich-shared-albums/compare/v0.5.0...v1.0.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* **p2p:** wire-contract completions — negotiation, codes, 410, hardening ([#38](https://github.com/lukeet332/immich-shared-albums/issues/38))
* **config:** the ISA_ env contract — one namespace, strict parsing ([#37](https://github.com/lukeet332/immich-shared-albums/issues/37))
* **state:** schema v1 — real tables, versioned, raw keys, honest names ([#36](https://github.com/lukeet332/immich-shared-albums/issues/36))
* all peer traffic moves to iroh — dial keys, not URLs ([#26](https://github.com/lukeet332/immich-shared-albums/issues/26))
* the share page becomes ours — native album framed under the join card ([#25](https://github.com/lukeet332/immich-shared-albums/issues/25))
* both pages are client-rendered and require JavaScript, each with a noscript saying why. Everything they do is an API call that needs JS anyway, so there was no useful pre-JS state to render.
* bot accounts are re-keyed from name-derived slugs to `person-<user id>`. Existing installs keep their old accounts as orphans; delete them or start clean. Household-wide sharing is gone — sharing names a person.
* an install still holding a pre-SQLite state.json will no longer import it, so it starts from empty state and must re-join its albums. No released version wrote that file, so this affects nobody in practice; flagged because the migration path is gone rather than deprecated.
* three changes need operator awareness, and none ship a migration. Bot users move to @immich-shared-albums.local from @sidecar.local; existing bots are not renamed. Household-wide invitations are gone, so any album shared that way must be re-shared to named people, and SHARE_USER_DIRECTORY=false now disables native invitations with that peer entirely rather than falling back to household-wide (share links are unaffected). Mapping.forPeerUserId becomes forPeerUserIds.
* the URL prefix moved from /sidecar/* to /immich-shared-albums/* with no compatibility shim. Both peers must run a version that agrees on it, and every reverse-proxy route needs updating.

### Features

* all peer traffic moves to iroh — dial keys, not URLs ([#26](https://github.com/lukeet332/immich-shared-albums/issues/26)) ([854f3ea](https://github.com/lukeet332/immich-shared-albums/commit/854f3ea57ec705cda07e3572c05ad711723205de))
* carry websocket upgrades so the sidecar can front Immich alone ([e5baa9b](https://github.com/lukeet332/immich-shared-albums/commit/e5baa9bbac069f001132342eff0d5c7d61675d5a))
* **config:** the ISA_ env contract — one namespace, strict parsing ([#37](https://github.com/lukeet332/immich-shared-albums/issues/37)) ([39ab710](https://github.com/lukeet332/immich-shared-albums/commit/39ab7100fa6c8245df8b9dad2990ddf091d8f1b8))
* **install:** IPP option, proxy choice, installer accuracy sweep ([#35](https://github.com/lukeet332/immich-shared-albums/issues/35)) ([e870d78](https://github.com/lukeet332/immich-shared-albums/commit/e870d78e514530e8621aeab7a1f4dc9257c53385))
* link two servers on their own, instead of via an album share link ([#18](https://github.com/lukeet332/immich-shared-albums/issues/18)) ([2f20214](https://github.com/lukeet332/immich-shared-albums/commit/2f202144837b60959f395a7e4eabebf65b97a51e))
* **naming:** don't stack 'server' when a household is already named one ([#40](https://github.com/lukeet332/immich-shared-albums/issues/40)) ([dac5ca5](https://github.com/lukeet332/immich-shared-albums/commit/dac5ca54769ae6a2eef43a0eb32bc147a6657636))
* one account per remote person, and stop the sidecar overruling a human ([#17](https://github.com/lukeet332/immich-shared-albums/issues/17)) ([cd13d7a](https://github.com/lukeet332/immich-shared-albums/commit/cd13d7a03d8b65d2760eecc7a47b86dee5c2b12a))
* one-show pairing, configurable TTL, vanilla-Immich parity (iron rule 8) ([#39](https://github.com/lukeet332/immich-shared-albums/issues/39)) ([db1c18b](https://github.com/lukeet332/immich-shared-albums/commit/db1c18b03a1b0c16323b30d79376484c96906010))
* **p2p:** wire-contract completions — negotiation, codes, 410, hardening ([#38](https://github.com/lukeet332/immich-shared-albums/issues/38)) ([c0cf95e](https://github.com/lukeet332/immich-shared-albums/commit/c0cf95e0bf54f4137489fca31d7f764914b33a55))
* rename the route prefix to /immich-shared-albums ([ad1bd79](https://github.com/lukeet332/immich-shared-albums/commit/ad1bd79241216f768f4154edfa0eba492fa9de1e))
* share albums by inviting a household in Immich's own picker ([460f967](https://github.com/lukeet332/immich-shared-albums/commit/460f967a5ad429e6997beb6b6bcc1ca3bf19faa8))
* share albums per person, and manage server links from the panel ([#13](https://github.com/lukeet332/immich-shared-albums/issues/13)) ([9d0f6c8](https://github.com/lukeet332/immich-shared-albums/commit/9d0f6c89dba069779b054659440bb51da0a613d4))
* **state:** schema v1 — real tables, versioned, raw keys, honest names ([#36](https://github.com/lukeet332/immich-shared-albums/issues/36)) ([54bde8c](https://github.com/lukeet332/immich-shared-albums/commit/54bde8c877b86dc18677272565ebb5b5bd29ebb5))
* the admin key shrinks from 'all' to sixteen enumerated permissions ([#27](https://github.com/lukeet332/immich-shared-albums/issues/27)) ([f3d0430](https://github.com/lukeet332/immich-shared-albums/commit/f3d04300c49c85005ee4f156e38e410514591454))
* the share page becomes ours — native album framed under the join card ([#25](https://github.com/lukeet332/immich-shared-albums/issues/25)) ([71bbf55](https://github.com/lukeet332/immich-shared-albums/commit/71bbf555e8db042534d22c6598ab15ae94327403))


### Bug Fixes

* e2e flakes — duplicate-stub race, unlink-survivor miscount ([#34](https://github.com/lukeet332/immich-shared-albums/issues/34)) ([204e755](https://github.com/lukeet332/immich-shared-albums/commit/204e755940dbf49cea39c7997512cd7785704acd))
* **e2e:** assert the mirror-owner account by id, not by its display name ([#21](https://github.com/lukeet332/immich-shared-albums/issues/21)) ([21eda34](https://github.com/lukeet332/immich-shared-albums/commit/21eda343c617088dca8c8fd712ad8382ac45060b))
* enable strictNullChecks, and fix the two real bugs it found ([#15](https://github.com/lukeet332/immich-shared-albums/issues/15)) ([3735460](https://github.com/lukeet332/immich-shared-albums/commit/37354609024bb199c7e2789953499b1c3192d16e))


### Reverts

* the 1.0.0 release — the v1 breaking window stays open ([#28](https://github.com/lukeet332/immich-shared-albums/issues/28)) ([87fa0bb](https://github.com/lukeet332/immich-shared-albums/commit/87fa0bb4a65bee74b8c3a9326f887b392cd6abbb))


### Miscellaneous Chores

* clear the v1 housekeeping while the clean-break window is open ([#16](https://github.com/lukeet332/immich-shared-albums/issues/16)) ([aaf946c](https://github.com/lukeet332/immich-shared-albums/commit/aaf946cb34d8b9014c8ea5226de14dfb0aa60941))


### Code Refactoring

* the two front-end pages become Preact TSX, and one table says what exists ([#19](https://github.com/lukeet332/immich-shared-albums/issues/19)) ([019f20e](https://github.com/lukeet332/immich-shared-albums/commit/019f20e16879b1223313af117b918e7f461c87d1))

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
