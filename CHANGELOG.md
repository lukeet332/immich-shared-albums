# Changelog

Versioning: **MAJOR** = a peer on the previous version can no longer sync with you,
or upgrading requires operator action (config/env/proxy changes). **MINOR** = new
features; older peers keep working (they just miss the optimisation). **PATCH** = fixes.
Watch this repo's releases to be notified when an update breaks contract.

## v0.2.0 — unreleased

- TypeScript throughout, run natively by Node's type stripping — still no build step
  and zero runtime dependencies; `npm run typecheck` gates CI so protocol/contract
  drift fails before the E2E suite.
- State moved from state.json to SQLite (built-in node:sqlite): crash-safe WAL,
  indexed seen-ledger lookups (scales past ~10k shared photos on low-power hosts),
  no more whole-file rewrites per synced photo. Legacy state.json migrates
  automatically on first boot (kept as state.json.migrated).
- Base image bumped to node:24-alpine. No operator action needed: same env vars,
  same volumes, same routes.

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
