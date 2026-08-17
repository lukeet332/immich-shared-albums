# `sync/` — the reconciliation loops

The background engine that keeps mirrors up to date in both directions. Runs on timers;
also driven on demand by nudges (`../p2p/protocol.ts`) so changes land in seconds.

| File | What it does |
|---|---|
| `engine.ts` | Photo sync. `watchOnce` pushes local additions out to peers; `reconcileOnce`/`reconcileMapping` pull the origin manifest, materialise anything missing, and **propagate deletions** (with a consistency gate so an indexing lag never wrongly deletes). `leaveAlbum` is the full reverse of a join — purges every stub, the mirror album, the mapping and its ledger. `startWatchLoop` runs it on an overlap-guarded interval. |
| `comments.ts` | Cross-server comments. The origin album is the source of truth: members pull the canonical list and push their own, gated by a cheap activity-count statistic so messages land in seconds without heavy polling. Includes the inbound `handleActivity`/`handleComments` handlers. `startCommentLoop` runs the fast lane. |

**Why loops and not just webhooks:** nudges make the common case instant, but the timed
sweep is the safety net — a lost nudge costs nothing because the next scheduled handshake
catches everything (fail-open by design). `RECONCILE_DEBUG=1` traces every decision.
