# Headless E2E

Fully API-driven cross-household test — **no phone, no emulator, no real server**.
Runs three throwaway mock Immich stacks (C origin, B and D joiners) and asserts
the whole flow, exits non-zero on any fail. A Playwright lane (browser-test.mjs) covers the banner/accept browser flows in CI.

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

## Keeping it fast (and still trustworthy)

This suite is the project's main safeguard, so **speed is never bought with a weaker assertion**.
Every wait here is either a convergence wait or a hang guard; none is padding. Rules, learned by
measurement — a full profile is printed with `E2E_PROFILE=1`:

1. **A fixed sleep is a waiting bug.** Work is eventually consistent, so `sleep(n)` either wastes
   time or passes despite a failure. Replace it with a wait on the condition, or — when the
   assertion is *"nothing happened"* — on the value **holding** for a period (`stable()`), which
   fails faster than a sleep when something does change.
2. **Never shorten a timeout.** Timeouts are hang guards that must essentially never fire;
   shortening one converts a clear assertion failure into a timeout. Shrink the *interval*, leave
   the *budget*.
3. **Wait on convergence, not on a clock.** The sidecar records its cursors only after a clean
   pass, and `sync/status.ts` exposes that as `settled` plus a cycle count — so a wait can end when
   the work ends instead of after a guess. Peers can ask the same question over
   `GET /albums/:mappingId/status` (feature `sync-status`; a 404 means an older peer — wait instead).
4. **The rig's poll interval is the dominant cost.** Every convergence wait is quantised by
   `ISA_SYNC_POLL_MS`, which is why the demo stacks set it low (`4000`) rather than the production
   default. Measured: dropping it from 15s saved more than shortening every test-side poll, because
   the waits end at the *system's* cadence, not the test's.
5. **Poll frequently, assert invariantly.** `E2E_POLL_MS` (default 1000) only controls how often we
   look; it cannot make a test pass that would otherwise fail.
6. **If a wait times out, fix the wait — not the timeout.** A timeout means either the interval is
   too coarse, the hold period too short, or there is a real convergence bug. Raising the number
   hides all three.
7. **Verify speed changes with repeat runs.** Three consecutive green runs, compared against a
   recorded per-stage baseline, is the bar for landing anything here — and check the image ID
   changed, since `run-mock-e2e.sh` continues past a failed `docker build` and will happily test
   stale code.
8. **An external probe must not be able to kill the run.** `irohProbe` spawns a container and does
   a live round trip, so it can fail transiently — the native addon has exited on SIGBUS mid-run.
   It retries once and then reports a status the check can fail on, because a throw here aborts the
   suite and hides every other result behind one flake. Any new out-of-process helper needs the
   same shape: bounded retry, structured failure, never an uncaught throw.

