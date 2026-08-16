# Headless E2E

Fully API-driven cross-household test — **no phone, no emulator, no production server**.
Runs two throwaway mock Immich stacks (B joiner, C origin) and asserts the whole flow.

```bash
./demo/run-mock-e2e.sh
```

Covers: join + manifest, mirror creation, utility-user ownership (no human owns mirror
assets), no-timeline-pollution on the origin, per-person contributor attribution,
capture-date preservation (album ordering), album People/owners documented in settings,
and loop-prevention across idle watcher cycles. 18 assertions, exits non-zero on any fail.
