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
4. **The rig's cadence reaches the suite through one value, `SYNC_POLL_MS`.** `stable()` proves
   *"nothing changed"* only over a window, and that window is `TWO_CYCLES_MS` (`2 × SYNC_POLL_MS`,
   read once from `ISA_SYNC_POLL_MS`, default `4000` to match the composes). It used to be a literal
   `8000`, which meant changing the rig's cadence left every hold-point at the old duration — an
   experiment that varied the cadence then measured a constant. `HOLD_DEADLINE_MS` is derived too, so
   a slower cadence can never make a deadline shorter than the hold it must allow. The value is
   clamped like the sidecar clamps it (floor 1000, else the default), so an empty or bad env can never
   produce a zero-length hold. `ISA_SYNC_POLL_MS` is a `workflow_dispatch` input, so a cadence
   experiment is one run of the same commit. History: PR #55's 15s→4s drop was the largest single
   reduction the suite has had (~499s→~320s wall); whether 4s→1s pays is the open experiment.
5. **A stage that cannot read its own evidence must fail, not skip.** Some stages read sidecar state
   through the sqlite3 CLI (`readSidecarPeers`, `readSidecarKv`, …). An unreadable `state.db` used to
   look identical to an empty one, so `native album invitations` and `a revocation survives content
   arriving in the same window` could run **zero checks** and still report green — silently dropping
   the coverage for per-person invitations. `requireState` now records a **failed check** naming the
   missing precondition and the stage runs no further checks — a failed check rather than a throw, so
   the rest of the suite still runs and the summary line still prints (rule 9). `E2E_ALLOW_SKIP=1`
   restores the old behaviour for a run that knowingly cannot read host state; it is a coverage trade,
   not a convenience, and CI must never set it.
6. **Poll frequently, assert invariantly.** `E2E_POLL_MS` (default 1000) only controls how often we
   look; it cannot make a test pass that would otherwise fail.
7. **If a wait times out, fix the wait — not the timeout.** A timeout means either the interval is
   too coarse, the hold period too short, or there is a real convergence bug. Raising the number
   hides all three.
8. **Verify speed changes with repeat runs.** Three consecutive green runs, compared against a
   recorded per-stage baseline, is the bar for landing anything here — and check the image ID
   changed, since `run-mock-e2e.sh` continues past a failed `docker build` and will happily test
   stale code.
9. **An external probe must not be able to kill the run.** `irohProbe` spawns a container and does
   a live round trip, so it can fail transiently — the native addon has exited on SIGBUS mid-run.
   It retries once and then reports a status the check can fail on, because a throw here aborts the
   suite and hides every other result behind one flake. Any new out-of-process helper needs the
   same shape: bounded retry, structured failure, never an uncaught throw.
10. **"It must survive N cycles" needs a count, not a duration.** A sleep cannot tell five cycles
    from none — a watcher that died on its first pass passes a 55s sleep identically. The sidecar
    counts every evaluation of its watcher and invite loops (`recordLoopTick` in `sync/status.ts`,
    called at the **top** of each tick, before any skip — unlike `cycles`, which counts passes that
    did work and therefore stops the moment a mapping settles). The rig reads it over
    `GET /immich-shared-albums/sync/status?albumId=` — present only with `ISA_TEST_HOOKS`,
    admin-only, absent from every real install. Wait for both counts to advance by N, then assert
    the value held. This is why the suite has no literal `sleep` left.

