# Headless E2E

Fully API-driven cross-household test — **no phone, no emulator, no real server**.
Runs three throwaway mock Immich stacks (C origin, B and D joiners) and asserts
the whole flow, 63 checks, exits non-zero on any fail. A Playwright lane (browser-test.mjs) covers the banner/accept browser flows in CI.

```bash
./demo/run-mock-e2e.sh
```

First time only: put admin API keys in `demo/.env` (`B_API_KEY=...`) and
`demo/household-c/.env` (`C_API_KEY=...`). On a fresh machine or CI,
`demo/ci/provision-mock.sh <base-url>` creates the admin and mints a key for you
— see `.github/workflows/e2e.yml`, which runs this exact suite on every push and
weekly against `immich-server:release`.

Covers: join + manifest; per-user (private) joins and idempotent re-joins (second
user attaches to the existing mirror, no duplicates); preview-grade mirroring
(explicitly NOT byte copies) with on-demand originals streamed byte-identical
from the owner — including chained through the origin for relayed photos — and
utility-user ownership (no human owns mirror assets); videos as playable
renditions; origin-timeline and joiner-timeline cleanliness; per-person
contributor attribution + avatar sync + uploader credit + stale-name healing;
capture-date and GPS preservation (album ordering); album People/owners
documented in settings; canonical comments (two-way sync, echo prevention, relay/backfill to a later-joining household); view-only links enforced (sync yes, uploads rejected); empty-album joins named after the sharer; owner
post-join additions; the same photo re-shared into a second album; instant join
with no preview wait (healed by reconciliation); member→member relay through the
origin (third household D receives B's contributions and vice versa, correctly
attributed); and loop prevention across idle watcher cycles — which also proves
the version handshake never wedges convergence.

The origin mock runs with password login disabled to mirror OAuth-only
production setups. Photo fixtures are 12 visually distinct JPEGs — identical
pixels would produce identical previews that Immich dedupes into one asset.
