# The Rust port — module map, parity contract and verification

`rust/` is the same sidecar as the TypeScript in `src/`, in Rust, and is meant to be a **drop-in
replacement** for it: the wire protocol, `state.db`, HTTP surface and env vars are unchanged, so
either build can sit on either end of a link and a Rust sidecar reads a `state.db` a Node one wrote.
`src/` remains the source of truth for behaviour; where this document and the TypeScript disagree,
the TypeScript is right and this document is a bug — except for the deliberate divergences listed
under _Differences from the TypeScript_ below.

Layout: `src/lib.rs` is the crate root, `src/main.rs` is the composition root (the `isa` binary), and
`src/config.rs` holds every setting. `examples/` holds the probes used against the rig.

## The drop-in contract (each row verified)

| Surface | Requirement | Held by | Verified by |
| --- | --- | --- | --- |
| Wire protocol | `PROTOCOL_VERSION = 2`, ALPN `isa/2`, `/hello` answers protocol + version + features | `src/protocol.rs`, `src/p2p/transport.rs` | `rust/peer-interop.mjs`, `rust/verify-sync.mjs` against a Node peer |
| Framing | 4-byte big-endian length prefix per frame, JSON headers | `src/p2p/frame.rs` | `rust/frame-interop.mjs` (Node writes, Rust reads, and back) |
| `state.db` schema | `SCHEMA_VERSION = 4`, same tables and columns | `src/store.rs` | `bash rust/verify-upgrade.sh` — the Rust build boots on a POPULATED database a Node sidecar wrote and loads its identity, peers, mappings and contributors |
| Identity key | `kv` row `identity`, `{v:1,alg:"ed25519",pub,priv,createdAt}`, raw 32-byte base64url — `pub` IS the iroh endpoint id | `src/state.rs` | `verify-upgrade.sh`: the Rust build takes over the SAME endpoint id a Node sidecar minted, so existing links keep working; the seed also DERIVES the stored public key |
| Env vars | the same 18 `ISA_*` names and defaults | `src/config.rs` | `grep -rho 'ISA_[A-Z0-9_]*' src/config.ts rust/src \| sort -u` — 18 shared names, plus `ISA_COMPAT_DB` (test-only) and two matches inside comments (`ISA_`, `ISA_INVITE_POLL_MS`, the latter being a name the TypeScript documents but does not define) |
| Route prefix | `/immich-shared-albums`, clean break away from `/sidecar` | `src/config.rs` | rig stage `route prefix rename + legacy compatibility` |
| HTTP routes | every path in the table below | `src/web/server.rs` | rig: each route has at least one check |
| Response shapes | `/health` → `{"ok":true,"protocol":2}`; unknown → `{"error":"not found"}` | `src/web/server.rs` | rig stages `route prefix rename + legacy compatibility`, `security (unauthenticated surface)` |
| Test contract | `#who`, `#go`, `#out`, `#openapp`, `#immich-shared-albums-banner .card`/`input`/`button.join`/`.err` | `src/web/assets.rs` | `demo/e2e/browser-test.mjs` |
| uid/gid | runs as uid 1000, `/data` owned by it | `rust/Dockerfile` | `bash rust/verify-image.sh` (uid, `/data` owner, HEALTHCHECK, identity across a restart) |
| Healthcheck | the image's own probe answers, so compose can gate on `service_healthy` | `rust/Dockerfile` | `bash rust/verify-image.sh` (`HEALTHCHECK: healthy`) and `bash rust/verify-install.sh` (install.sh probes it with `wget` inside the container) |
| Panels' SSE | `GET /events`, `text/event-stream`, `{type}` hint only | `src/web/panel_events.rs` | rig `/test/emit` + browser lane's no-reload checks |
| Bot accounts | one account per remote person, no retained password, scoped keys, no `apiKey.create` | `src/immich/contributors.rs`, `src/sync/house_bot.rs` | rig `bot naming`, `security (utility accounts cannot be signed into)` |

## Module map (TypeScript → Rust)

Same name, `.ts` → `.rs`, in the same folder, unless listed otherwise.

| TypeScript | Rust | Note |
| --- | --- | --- |
| `index.ts` | `main.rs` | composition root: config → state → transport → web → lanes → hello |
| `types.ts` | `protocol.rs` | `PROTOCOL_VERSION`, `PROTOCOL_FEATURES`, `SIDECAR_VERSION` |
| `config.ts` | `config.rs` | every `ISA_*` setting; strict parsing, fails loudly at boot |
| `state.ts`, `store.ts`, `sweeps.ts`, `panel-events.ts` | `state.rs`, `store.rs`, `sync/sweeps.rs`, `web/panel_events.rs` | |
| `peers.ts` | `p2p/protocol.rs` | peer lookups and nudges live with the routes that use them |
| `immich/shape.ts` | `immich/refs.rs` | `display_dims` — the EXIF-orientation-aware layout size |
| `immich/admin-key.ts`, `immich/migrate-domain.ts` | `immich/admin_key.rs`, `immich/migrate_domain.rs` | boot diagnostics and the legacy-domain rename |
| `media/interceptor.ts` | `web/interceptor.rs` | it is an HTTP path, so it lives with the HTTP surface |
| `p2p/mirror.ts` | `sync/mirror.rs` | mirroring is album sync, not transport |
| `sync/album-invite.ts` | `sync/album_index.rs` (`invite_peer_to_reunite`) | the panel's Invite, beside the index it reads |
| `web/me.ts` | `web/server.rs` + `sync/album_index.rs` | the caller-scoped reads are handlers; the derivations are sync |
| `shutdown.ts` | `main.rs` (`shutdown_signal`) | |
| `immich/access.ts` | `immich/access.rs` | caller-scoped reads: which albums a credential may see |
| `immich/bot-avatar.ts` | `immich/bot_avatar.rs` | the hand-drawn PNG the addon's own accounts wear |
| `immich/stand-in-picture.ts` | `immich/stand_in_picture.rs` | whose face an account of ours wears |
| `immich/client.ts`, `contributors.ts`, `materialise.ts`, `refs.ts`, `unmeasured.ts` | same names, `.rs` | |
| `media/cache.ts`, `media/jpeg.ts`, `media/proxy.ts` | same names, `.rs` | |
| `p2p/entitlement.ts`, `join.ts`, `pair.ts`, `protocol.ts`, `routes.ts`, `transport.ts`, `unlink.ts` | same names, `.rs` | |
| `sync/adoption.ts`, `album-grant.ts`, `album-index.ts`, `album-suppression.ts`, `album-teardown.ts`, `audit.ts`, `backfill.ts`, `comments.ts`, `engine.ts`, `house-bot.ts`, `index-freshness.ts`, `index-offer.ts`, `invitees.ts`, `invites.ts`, `leave.ts`, `matches.ts`, `peer-mapping-id.ts`, `status.ts`, `traffic-triggers.ts` | same names, `.rs` | |
| `web/assets.ts`, `auth.ts`, `frontend.ts`, `passthrough.ts`, `server.ts`, `upgrade.ts` | same names, `.rs` | |
| everything else | same path, `.rs` | |

Rust-only modules, and what earns them a file:

- `p2p/frame.rs` — the length-prefixed frame codec. The TypeScript gets framing from iroh's stream
  API; a Rust peer must produce the same bytes, so the codec is explicit here.
- `p2p/upgrade.rs` → `web/upgrade.rs` — protocol upgrades (websockets) piped at the socket level.
  `passthrough` speaks request/response through a pooled client, and an upgrade is neither.
- `web/query.rs` — query-string helpers used by several routes.
- `web/album_member_audit.rs` — the album's own record of somebody being taken off it: one short
  sentence naming the person, like every other line the port writes. Whether that removal revoked
  anything depends on the kind of share — an invitation's membership IS the share, a link's is not —
  and that reasoning stays in the docs rather than being posted into somebody's album. Nothing in the
  TypeScript does this. Every audit line follows one formula: who, what happened, full stop.
- `sync/trail.rs` — audit lines that WAIT for the album's owner. Our bot can only be put on an album by
  someone who can already change it (Immich refuses the admin key), so a peer's join or leave — an
  event that happens while the owner is elsewhere — is queued in `trail_pending` and written on their
  next panel visit, which is the one moment we hold their credential and the list of albums they own.
  One drain at a time (`try_lock`): a panel reads `/me/albums` twice, and two drains would post the
  same line twice. Bounded retries, because a line for an album that is gone must stop asking.
- `web/share_link_audit.rs` — the album's own record of a share link being withdrawn. The delete
  passes through the proxy, so the album it granted is resolved BEFORE the request is forwarded (while
  the link still answers) and the line is posted afterwards with the OWNER's credentials — the only
  ones that can put our bot on their album. Nothing in the TypeScript does this.
- `web/activity_filter.rs` — hiding our own audit lines from ONE reader, in the answer they were
  served. Immich's comment history reaches the browser as `GET /api/activities` through our
  passthrough, so a per-person visibility preference can be honoured without touching Immich: the rows
  stay in the database and stay in every other reader's view. The tag written when a line was posted
  is what the filter matches, NOT the author — the relay posts another household's human comment as
  that person's stand-in, and falls back to our own bot.
- `sync/directory.rs` — the directory lane (`start_directory_loop`), which in the TypeScript is wired
  in `index.ts` beside the other two lanes.
- `sync/link_grants.rs` — a link join lasts exactly as long as its link: the origin re-reads its own
  `/shared-links` and retires any grant whose album is no longer shared that way. Nothing in the
  TypeScript ever re-reads a link after redeem, so a link share could only be ended by unlinking the
  whole household. Runs inside the invite sweep, which is the lane that already asks who is still
  allowed in. `expiresAt` is NOT treated as a withdrawal: a link row this code cannot fully read must
  not revoke somebody's share, and ending joins that already happened on expiry is its own decision.
- `examples/*.rs` — the probes: `frame_server`, `peer_server`, `seed_proxy`, `seed_member`,
  `leave_probe`, `redeem_probe`, `house_bot_probe`, `caller_albums_probe`, `materialise_probe`,
  `provision_probe`, `reconcile_probe`, `origin_push`, `jpeg_dump`.

## HTTP surface

Dispatch order in `src/web/server.rs` is **load-bearing**; each step's position is the reason it is
where it is.

0. `Upgrade: websocket` → `web/upgrade.rs` pipes the socket to Immich. Immich's live web updates are a
   websocket, and this is what makes the sidecar viable as the single front for Immich.
1. Human surfaces (pages, scripts) from the table in `web/frontend.rs` — fail closed on the caller's
   own Immich credential, served before the body cap because none of them has a body.
2. `/share/:key` → the join card, or `?native=1` straight through to Immich.
3. Byte interceptors for proxy assets (`/api/assets/:id/{thumbnail,original,video/playback}`).
4. Everything else that is not ours → `passthrough`, streamed both ways. AFTER the response, a
   traffic trigger may refresh a person's album index or push a comment (`sync/traffic_triggers.rs`).
5. The sidecar's own routes cap the body before reading it.
6. `/immich-shared-albums/*` JSON and HTML routes.
7. `/health`.
8. 404 `{"error":"not found"}`.

| Route | Method | Auth | Notes |
| --- | --- | --- | --- |
| `/` and the four surfaces | GET | per surface | see `web/frontend.rs` |
| `/assets/*.js`, `/assets/tokens.css` | GET | public | shared by the surfaces |
| `/share/:key` | GET | public | `?native=1` = Immich's own page |
| `/health` | GET | public | `{"ok":true,"protocol":2}` |
| `/events` | GET | signed in | SSE hints: `{type}` of `invitations`/`index`/`shares` |
| `/peers` | GET | admin | one row per link, with what it carries |
| `/settings` | GET, POST | admin | |
| `/pairings` | GET, POST | admin | mint a link, list pending |
| `/pairings/revoke` | POST | admin | |
| `/pair` | POST | admin | redeem a pairing link |
| `/unlink` | POST | admin | sever a link and delete its people and photos |
| `/leave` | POST | admin | give up a joined album |
| `/join`, `/join/preview` | POST | signed in | redeem a share; preview what it would add |
| `/me/albums` | GET | signed in | the caller's shared albums, from Immich |
| `/me/albums/publish` | POST | signed in | offer the caller's own albums to one peer |
| `/me/matches` | GET | signed in | possible reunions, each with its `step` and (for `accept`) a top-level `mappingId` |
| `/me/preferences` | GET, POST | signed in | the CALLER's own row: whether the addon's album activity is visible to them (`auditVisibleInComments`, default true). A body naming somebody else is ignored |
| `/me/invite` | POST | signed in | the panel's Invite: one membership, on the caller's own album |
| `/me/reunite` | POST | signed in | move a share onto an album the caller owns |
| `/me/unreunite` | POST | signed in | undo the adoption, keep the share |
| `/sync/status` | GET | admin, `ISA_TEST_HOOKS` | ticks, nudges, hints, per-album status |
| `/test/emit` | POST | admin, `ISA_TEST_HOOKS` | emit a panel hint; answers how many panels listen |
| `/test/pause-sweeps` | POST | admin, `ISA_TEST_HOOKS` | hold every background lane; answers `{paused, idle}` |
| `/test/new-session` | POST | admin, `ISA_TEST_HOOKS` | forget the traffic-freshness sessions |
| `/test/hide-dimensions` | POST | admin, `ISA_TEST_HOOKS` | pretend Immich has not measured a photo |

## Peer (iroh) surface

`src/p2p/routes.rs`, in match order. Every route resolves the mapping from the CALLER's key, so a
valid connection can never address someone else's album.

| Route | Answers |
| --- | --- |
| `/hello` | protocol, version, feature list |
| `/pair` | redeem a pairing code |
| `/invites/redeem` | redeem a share link (403 when link joining is off) |
| `/albums/:id/refs` | a push (`add` refs, and additively `remove`: origin asset ids the sender no longer holds, whose stubs here are purged — the joiner-deletes-their-contribution path) |
| `/albums/:id/activity`, `/comments` | the conversation, both directions |
| `/albums/:id/invitations`, `/invitations/nudge` | what this household is invited to, and "look again" |
| `/directory` | the people this household offers (names only) |
| `/albums` | the album index this household offers |
| `/albums/:id/reunified` | "we merged this share into our own album" |
| `/albums/:id/version`, `/manifest`, `/status`, `/leave`, `/nudge` | the sync reads, the courtesy leave, and "look again" |
| `/index/nudge` | "what you publish has changed" |
| `/users/:id/avatar` | one person's picture, for the stand-in that speaks for them here |
| `/assets/:id/{preview,original,playback}` | bytes, entitlement-checked |
| anything else | 404, never a dropped stream |

## Rules that bite in Rust, and how they are enforced

- **`State::collections()` is not reentrant.** It returns a `CollectionsGuard` that PANICS if the
  same thread takes it twice, because the alternative is a silent deadlock that blocks every other
  task while looking like a hang: the shape cost this port several debugging rounds. Bind the guard
  in its own statement — never as an argument, an `if let` scrutinee, or inside a closure.
- **A guard must not live across an `.await`.** The compiler refuses it as a non-`Send` future;
  `clippy::await_holding_lock` names the line. Bind what you need from the guard, drop it, then await.
- **The Docker build context is the REPO ROOT**, not `rust/`: `src/web/assets.rs` embeds the built UI
  with `include_str!("../../../src/web/dist/…")`. Build with `docker build -f rust/Dockerfile .`.
- **`/tmp` is not shared with the Docker daemon.** A file a container writes to a bind-mounted `/tmp`
  lands in the daemon's `/tmp` while this shell reads its own — so a state database "copied to /tmp"
  reads as empty and the failure looks like a compatibility bug. Keep rig state under `rust/target/`.
- **The sidecar image has no Node.** Nothing in it may shell out to `node`, and no test harness may
  assume it can: the rig runs its probes from a separate Node image (`immich-shared-albums:probe`).
- **A stale comment is a bug.** Several rounds were lost to comments that described code that had
  since been ported (`leave_album is not ported yet`) or to a plan that had been abandoned.
- **A nudge is not a sweep, and must not be gated like one.** `handle_invitations_nudge` starts
  `pull_invitations_soon`, which is deliberately outside `sweeps_are_paused`: the browser lane holds
  every sweep and then proves a person's invitation still reaches an already-open panel. A nudge that
  only *records* itself answers `{ok:true}` and changes nothing.
- **`Client` paths are relative to `{ISA_IMMICH_URL}/api`.** Passing `/api/…` builds `/api/api/…`,
  which Immich answers `404 Cannot POST /api/api/...` — a mistake that reads like a missing feature.
  `refuse_doubled_api_prefix` refuses it instead.

## Verification

| Lane | What it proves | Command | Expected |
| --- | --- | --- | --- |
| Unit | pure logic, exactly | `cd rust && cargo test --lib` | `255 passed; 0 failed; 1 ignored` (the ignored one reads a Node-written `state.db`: `ISA_COMPAT_DB=… cargo test -- --ignored`) |
| Lint | the guard rules above | `cd rust && cargo clippy --all-targets` | no errors |
| Image | the container contract: uid 1000, `/data` writable and owned by it, `HEALTHCHECK` healthy, the identity survives a restart | `bash rust/verify-image.sh` | `PASS — image contract holds` |
| Panel | the Rust sidecar's own panel signs in and renders, with the sidecar fronting Immich on one origin | `bash rust/verify-panel.sh` | `5/5 checks passed` (incl. the "Create a link" button the install docs name) |
| Rig | cross-household behaviour against live mock Immich stacks, with the Rust image as all three sidecars | `ISA_DOCKERFILE=rust/Dockerfile bash demo/run-mock-e2e.sh` | `ALL PASS (270 checks)` — 28 more than the TypeScript lane runs, the Rust-only gates (`native leave`, `unlink`'s ledger cleanup, `store-shared-locally`) among them |
| Browser | the banner, the accept page, the chooser, the settings card and the panel's live flows in Chromium | `cd demo/e2e && CKEY=… B_EMAIL=admin@e2e.local B_PASS=… node browser-test.mjs` | `BROWSER PASS (61 checks)` (the lane skips one check when C is not password-hardened) |
| Install | `deploy/install.sh` runs end to end and produces a working install | `bash rust/verify-install.sh` | `PASS — install.sh installed rust/Dockerfile end to end` |
| Node lane | the TypeScript baseline still passes, i.e. the rig itself is sound | `bash demo/run-mock-e2e.sh` | `ALL PASS (228 checks)` |

The drop-in proof, in full — a `state.db` written by the TypeScript sidecar, read by the Rust crate:

```bash
# 1. run the NODE sidecar once, against the rig, into a throwaway data dir
docker run -d --name node-state-writer --network household-b_default \
  -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)" \
  -e ISA_HOUSEHOLD_NAME="Node writer" -e ISA_RELAY=off -v "$PWD/rust/target/node-state":/data \
  immich-shared-albums:node
docker stop node-state-writer && docker rm node-state-writer
# 2. read it with the Rust crate
cd rust && ISA_COMPAT_DB="$PWD/target/node-state" cargo test --lib -- --ignored reads_a_real_node_written_state_db
```

Focused lanes in `rust/`, one flow each. The counts are from a run against the live rig; the
container-based ones start their own sidecar unless they say otherwise.

| Lane | Checks | What it pins | Needs |
| --- | --- | --- | --- |
| `frame-interop.mjs` | 10/10 | the `isa/2` framing codec against `demo/e2e/iroh-client.mjs`, the independent JavaScript implementation the e2e suite itself uses | `cargo build --example frame_server`, `ISA_ROOT=<repo>` |
| `peer-interop.mjs` | 9/9 | a real JS iroh endpoint dials the Rust endpoint: handshake, features, the caller's identity from the connection, Range and body bytes verbatim, 404 for an unknown route | `cargo build --example peer_server` |
| `verify-refs.mjs` | 21/21 | a JS peer pushes a ref into the real `isa` binary: the stub's owner, size, aspect, capture date, GPS, rating and credit line | self-hosting, `BKEY` exported |
| `verify-sync.mjs` | 16/16 | the pull side: the version token's shape, manifest, `/status`, entitlement from a pull, and 410 GONE (not 404) after a leave | a sidecar on `:9410`, `BKEY` exported |
| `verify-bytes.mjs` | 10/10 | the byte routes and the entitlement gate: an offered asset IS readable, an unshared one is 403, an invented asset id is 403, an unknown peer is 403 | a sidecar on `:9410`, `BKEY` exported |
| `verify-redeem.mjs` | 25/25 | the enrolment path and every gate that can refuse it: a reused link, an unknown key, a password-gated link with no password or the wrong one, a malformed body, and the setting that turns link joining off at the PEER route as well as on the page | a sidecar on `:9410`, `BKEY` exported |
| `verify-pairing.mjs` | 17/17 | two Rust sidecars pairing over the real wire: single-use links, replay refused, stale refused, both sides listed, the protocol the peer advertised | two sidecars on `:9410`/`:9420` named `Household Alpha`/`Beta` |
| `verify-interceptor.mjs` | 10/10 | `/api/assets/:id/thumbnail` across two servers: a MISS comes from the owner byte for byte, a repeat is a cache HIT | self-hosting, `BKEY` exported |
| `verify-share.mjs` | 13/13 | the join card in Chromium over the framed native album, `?native=1` untouched, dismissal handing over to Immich | a sidecar on `:9400`, `SHARE_KEY` and `SHARE_ALBUM` exported, a screenshot path under `rust/target/` |
| `verify-share-browser.mjs` | 7/7 | `deploy/INSTALL-AI.md`'s VERIFY step 2 on its own: the card only exists once `share.js` has mounted, so a browser is the only thing that can answer it | a sidecar on `:8391`, `BKEY` exported |
| `jpeg-parity.mjs` | 12/12 | the stub generator's bytes against the TypeScript's, size for size | |
| `verify-join.sh` | pass | the MEMBER half of the handshake against a real origin: a refused join pins no peer, a re-dial does not enrol twice, a password-gated album asks for a password | the rig |
| `verify-leave.sh` | pass | the purge reclaims the space: the stand-in's stub is gone, the mapping is gone, and the admin key could never have seen it | the rig |
| `verify-leave-route.sh` | pass | `POST /leave` reaches the engine, and the admin gate in front of it holds | the rig |
| `verify-upgrade.sh` | 9/9 | **the drop-in upgrade**: drives a NODE sidecar to a populated state (mapping, ledger row with an origin, contributors), stops it, boots the RUST image on that database, and checks the identity is the same, the peers and mapping are read back, the ledger row's stub streams byte-identically from its owner, and the store's compat test parses it | the rig with the NODE image as B's sidecar |
| `verify-image.sh` | pass | the container contract: uid 1000, `/data`, `HEALTHCHECK`, identity across a restart | the Rust image |
| `verify-install.sh` | pass | `deploy/install.sh` end to end, through its prompts: health, the 600 `.env`, uid 1000, the panel's 401, Immich pass-through | the rig |
| `verify-panel.sh` | 5/5 | the panel signs in and renders through ONE origin, offers the "Create a link" button the install docs name, and logs no page errors | the rig |
| `bench.sh`, `bench-latency.mjs` | — | the numbers in the performance table | the rig |

## Differences from the TypeScript, and how they are known

The module map above is the claim that every module has a counterpart. Upgrading a populated install
is verified rather than assumed: `verify-upgrade.sh` boots the Rust build on a database a Node sidecar
wrote while it was serving — identity, peers, a member mapping, ledger rows and contributor keys — and
serves a Node-written ledger stub from its owner, byte for byte. Two differences are deliberate, and
neither is reachable from the wire:

- `ISA_COMPAT_DB` exists only in the Rust build. It points the compatibility check at a
  Node-written `state.db`, so it has no meaning in the build that writes them.
- `hello_peers` records `peer.protocol`/`features`/`version` at boot, from each peer's `/hello`. A
  peer that was unreachable then keeps `NULL` until the next boot, in both builds, and nothing on
  either side gates on the stored value — the only protocol check anywhere is a fail-open warning
  against the live handshake.

Two of the TypeScript's documented drifts are deliberate and must NOT be "fixed" in the port — see
`src/p2p/wire-protocol.md`: the ALPN string (rule 3), and `/albums/:id/status`, which is answered
over iroh but never dialled.

Two more are deliberate and go the other way: the port fixes a behaviour the TypeScript gets wrong.
Three, counting the provisioning lock below.

- **A leave keeps the stored copies the household paid for.** With `storeSharedAssetsLocally` on, a
  mirror row carries `storedFull` and its bytes are a real local asset. `leave_album` skips those
  rows and `seen_forget_proxies` keeps exactly them, so the copy and its ledger row outlive the
  share. The TypeScript reads `storedFull` nowhere in `leave.ts` or `unlink.ts`, so it purges a
  stored copy with everything else. UNLINKING still takes them in both builds, because `force: true`
  deletes the peer's accounts with their assets — the port drops the ledger rows with them
  (`seen_forget_mapping`), the TypeScript leaves the rows behind.
- **A native leave is noticed without the album's `updatedAt` moving.** `last_human_left` runs BEFORE
  `watch_mapping`'s unchanged-album handshake, because Immich bumps `album.updatedAt` on album edits
  and NOT when a member leaves. The TypeScript's native-leave check sits after its
  `album.updatedAt === mapping.localVersion` guard, so a person who leaves an album in Immich's own
  UI is never noticed: the mirror, its stubs and the mapping stay for ever. That is why the rig's
  `native leave` checks are scoped to the Rust lane.
- **A link join ends when its link does.** `retire_withdrawn_link_grants` re-reads the origin's own
  share links and retires a `role: owner, via: link` mapping whose album is no longer shared by link:
  the member's next `/version` gets 410, which is the teardown it already performs, and the origin
  reclaims the contributed photos on the way out (stored-FULL copies kept, as a leave does). The
  TypeScript never re-reads a link after redeem, so a link share there can only be ended by unlinking
  the household.
- **Minting a key borrows the password-login setting only on EVIDENCE.** `ensure_utility_user` tries
  the login first and reads `system-config` only after a refusal, because Immich caches that setting:
  deciding from the read made a stale "disabled" restore `disabled` over an enable the addon never
  made, so an operator's change was silently reverted and every sign-in answered `Password login has
  been disabled`. The TypeScript reads it up front and has the same clobber.
- **Placing a person is serialised per email.** `provision_lock` gives `ensure_utility_user` one
  provision per email, because two loops reaching the same person at once both `POST /admin/users`
  and Immich answers the loser `duplicate key value violates unique constraint "user_email_uq"`; the
  loser's recovery resets the password the winner is still logging in with, and the winner reports
  `login failed for … — will retry` on a join, an invite or a comment. Observed on the rig in both
  builds — `sidecar-b` "could not create an invite target", `sidecar-d` "comment sync error", with the
  Postgres error in `immich-b` — and intermittent, because it needs two loops to arrive together. The
  TypeScript has no such lock.

## Performance, Rust against the TypeScript it replaces

Both are measured as the ARTEFACT that ships: one container per image, on the same box, against the
same mock Immich, with the same work asked of each. Image size, cold start and RSS come from
`rust/bench.sh` (which spawns a `curl` per request, so its latency means are dominated by process
spawn and are not quoted here); latency and throughput come from `rust/bench-latency.mjs`, which uses
a keep-alive client — 2000 sequential requests and 2000 concurrent (50 in flight) per endpoint.

| Metric | TypeScript | Rust | Ratio |
| --- | --- | --- | --- |
| Image size | 75.1 MB | 9.7 MB | 7.8× smaller |
| Cold start to a healthy answer | 0.701 s | 0.320 s | 2.2× faster |
| RSS, idle | 97.5 MB | 6.6 MB | 14.7× smaller |
| RSS, after 300 requests | 114.1 MB | 7.1 MB | 16.2× smaller |
| Threads | 20 | 10 | 2× fewer |
| `/health` mean / p50 / p95 ms | 0.34 / 0.29 / 0.63 | 0.19 / 0.18 / 0.27 | 1.8× faster |
| Embedded bundle mean / p50 / p95 ms | 0.30 / 0.26 / 0.48 | 0.20 / 0.17 / 0.36 | 1.5× faster |
| Passthrough mean / p50 / p95 ms | 0.95 / 0.80 / 1.94 | 0.41 / 0.36 / 0.70 | 2.3× faster |
| `/health` throughput | 6830 rps | 10134 rps | 1.5× |
| Passthrough throughput | 2497 rps | 5559 rps | 2.2× |

Node grows ~16 MB under that load; the Rust binary grows 0.4 MB. The memory difference is the
interesting one: it is the difference between a runtime with a GC heap and one without.
