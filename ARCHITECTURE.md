# Architecture — the sidecar in Rust

`` is the sidecar: the addon that fronts Immich, pairs households, and moves albums between
servers. `src/lib.rs` is the crate root, `src/main.rs` is the composition root (the `isa` binary),
`src/config.rs` holds every setting, and `src/web/assets.rs` embeds the built UI. `examples/` holds the
probes used against the rig, including `probe.rs` — the assertion suite's wire oracle, one
JSON job in, one `{status, json|bytesLength}` answer out, speaking the crate's own framing.

## Iron rules

1. **Stock Immich is never modified.** All cleverness lives at the reverse proxy or behind the
   public API.
2. **Every injected surface fails open.** Immich must work perfectly with the sidecar dead.
3. **The app only ever touches its own server's ordinary data.**
4. **Ownership stays with the photo's taker.** Other households hold kilobyte placeholders; every
   pixel streams from its owner on demand, and is stored elsewhere only when a user explicitly saves
   it to their own library.
5. **Default-closed.** No uninvited server reaches anything.
6. **Reachability is never permission.** Every route assumes it is published to the open internet.
   Human routes authenticate against the caller's own Immich session; peer routes require the
   mutual-TLS connection's identity _and_ an entitlement check. Nothing is protected by being hard to
   find, on a private network, or behind a URL nobody has guessed.
7. **The sidecar invents no identities and holds no logins.** The only identity that means anything
   is an Immich one. The accounts that own stubs get a narrowly-scoped API key and no retained
   password, so they cannot be signed into at all.
8. **Vanilla Immich is the behavioural contract.** A user on another server operates as functionally
   identically to a user on the same server as this layer can manage: album roles, who may extend an
   album, what a viewer versus an editor can do — all of it is Immich's semantics, inherited, never
   re-invented here as stricter or looser rules. Concretely: an editor of a mirror can add members
   (so a received album can be re-shared onward), because that is exactly what an editor of any
   Immich album can do. If that semantic has holes, they are Immich's to patch — and when Immich
   patches them, this layer inherits the fix by doing nothing.

**Where this falls short today:** the sidecar needs a key on an admin **account** (user CRUD is
admin-only; Immich has no service accounts), scoped to the enumerated list in
`immich/admin_key.rs` — a leaked key cannot touch photos, settings, or mint a broader key, but it can
still manage users. It also creates real user accounts — one per remote person — that appear in every
picker, for the same reason. Known costs; do not make either worse without saying so.

## Module map

| Module | Carries |
| --- | --- |
| `main.rs` | composition root: config → state → transport → web → lanes → hello, and the shutdown signal |
| `config.rs` | every `ISA_*` setting; strict parsing, fails loudly at boot |
| `state.rs`, `store.rs` | in-memory collections over `state.db`; the schema and its migrations |
| `immich/access.rs` | caller-scoped reads: which albums a credential may see |
| `immich/admin_key.rs` | the scoped admin-account key, and what it may never do |
| `immich/bot_avatar.rs` | the hand-drawn PNG the addon's own accounts wear |
| `immich/stand_in_picture.rs` | whose face an account of ours wears |
| `immich/client.rs`, `contributors.rs`, `materialise.rs`, `refs.rs`, `unmeasured.rs` | the Immich API layer: transport, one account per remote person, stub materialisation, ref shapes, unmeasured-photo holds |
| `immich/migrate_domain.rs` | the legacy-domain rename at boot |
| `media/cache.rs`, `jpeg.rs`, `proxy.rs` | the byte path: cache, the stub generator, the proxy that streams from owners |
| `p2p/entitlement.rs` | what a linked household may reach |
| `p2p/frame.rs` | the length-prefixed frame codec (`isa/2`) |
| `p2p/join.rs`, `pair.rs`, `unlink.rs` | joining a share, pairing two servers, severing a link |
| `p2p/protocol.rs` | `PROTOCOL_VERSION`, `PROTOCOL_FEATURES`, `SIDECAR_VERSION`, peer lookups and nudges |
| `p2p/routes.rs` | the peer routes, in match order |
| `p2p/transport.rs` | the iroh endpoint and dialing |
| `p2p/upgrade.rs`, `web/upgrade.rs` | protocol upgrades (websockets) piped at the socket level |
| `sync/album_grant.rs` | the grant a share carries, and its withdrawal |
| `sync/album_index.rs` | the album index a household offers, and the panel's Invite (`invite_peer_to_reunite`) |
| `sync/album_suppression.rs` | suppressing an album a household has declined |
| `sync/album_teardown.rs` | what happens to albums when a share ends |
| `sync/audit.rs` | the audit line: one sentence, posted as the house bot |
| `sync/backfill.rs` | reconciling a mirror after a join |
| `sync/comments.rs` | the conversation, both directions — comments and likes |
| `sync/directory.rs` | the directory lane: the people each server offers |
| `sync/engine.rs` | the push/pull engine, and the retirement of a share whose peer went silent |
| `sync/house_bot.rs` | the house bot: provisioning, permissions, placement |
| `sync/index_freshness.rs`, `index_offer.rs` | what is published, and when it went stale |
| `sync/invitees.rs`, `invites.rs` | who an invitation is for, and the invitation lane |
| `sync/leave.rs` | undoing a join, and what it reclaims |
| `sync/link_grants.rs` | a link join lasts exactly as long as its link |
| `sync/matches.rs` | possible reunions, each with its `step` |
| `sync/mirror.rs` | the mirror: a member's view of an origin's album |
| `sync/peer_mapping_id.rs` | how one album's id is named on the other side |
| `sync/status.rs` | the tick/nudge/hint status the panel reads |
| `sync/sweeps.rs` | the sweep gate: one background lane at a time |
| `sync/trail.rs` | audit lines that wait for the album's owner |
| `sync/traffic_triggers.rs` | post-response triggers: index refresh, comment push, removals |
| `web/activity_filter.rs` | hiding our own audit lines from one reader, in the answer they were served |
| `web/album_member_audit.rs` | the album's own record of somebody being taken off it |
| `web/assets.rs` | the embedded UI, and the per-request token substitution |
| `web/auth.rs` | who the caller is, from their own Immich session or an API key |
| `web/frontend.rs` | the human surfaces and what each may see |
| `web/interceptor.rs` | byte interceptors for proxy assets |
| `web/passthrough.rs` | everything that is not ours, streamed both ways |
| `web/query.rs` | query-string helpers |
| `web/server.rs` | dispatch order, and the sidecar's own routes |
| `web/share_link_audit.rs` | the album's own record of a share link being withdrawn |

Rust-only behaviours, and what earns them:

- `web/album_member_audit.rs` — one short sentence naming the person, like every other line the
  sidecar writes. Whether that removal revoked anything depends on the kind of share — an
  invitation's membership IS the share, a link's is not — and that reasoning stays in the docs rather
  than being posted into somebody's album. Every audit line follows one formula: who, what happened,
  full stop.
- `sync/comments.rs`, like half — Immich's activities are comments AND likes, and both belong to the
  conversation: the like rides the activity payload with a `type` (the way `remove` rides the refs
  payload), both gates count likes, and a like is materialised on the other side AS THE PERSON who
  made it. The canonical list and the materialiser also refuse our own machinery's lines, so a peer
  never provisions an account for OUR bot. A like that is UN-liked is not propagated — that matches
  comments, whose deletions do not propagate either.
- `sync/trail.rs` — audit lines that WAIT for the album's owner, and the survivor's record of a share
  whose peer went silent (`retire_dead_share`, driven by the invite loop's per-share handshake, which
  counts 403 as well as 404: an unlink removes the peer before it stops answering anything else). Our
  bot can only be put on an album by someone who can already change it (Immich refuses the admin
  key), so a peer's join or leave — an event that happens while the owner is elsewhere — is queued in
  `trail_pending` and written on their next panel visit, which is the one moment we hold their
  credential and the list of albums they own. One drain at a time (`try_lock`): a panel reads
  `/me/albums` twice, and two drains would post the same line twice. Bounded retries, because a line
  for an album that is gone must stop asking.
- `web/share_link_audit.rs` — the delete passes through the proxy, so the album it granted is
  resolved BEFORE the request is forwarded (while the link still answers) and the line is posted
  afterwards with the OWNER's credentials — the only ones that can put our bot on their album.
- `web/activity_filter.rs` — Immich's comment history reaches the browser as `GET /api/activities`
  through our passthrough, so a per-person visibility preference can be honoured without touching
  Immich: the rows stay in the database and stay in every other reader's view. The filter matches the
  tag written when a line was posted, NOT the author — the relay posts another household's human
  comment as that person's stand-in, and falls back to our own bot.
- `sync/link_grants.rs` — the origin re-reads its own `/shared-links` and retires any grant whose
  album is no longer shared that way. `expiresAt` is NOT treated as a withdrawal: a link row this
  code cannot fully read must not revoke somebody's share, and ending joins that already happened on
  expiry is Immich's own enforcement.
- `sync/leave.rs` — with `storeSharedAssetsLocally` on, a mirror row carries `storedFull` and its
  bytes are a real local asset: `leave_album` skips those rows and `seen_forget_proxies` keeps exactly
  them, so the copy and its ledger row outlive the share. Unlinking still takes them, because
  `force: true` deletes the peer's accounts with their assets — and drops the ledger rows with them
  (`seen_forget_mapping`).
- `sync/engine.rs` — `last_human_left` runs BEFORE the unchanged-album handshake, because Immich bumps
  `album.updatedAt` on album edits and NOT when a member leaves.
- `immich/contributors.rs` — placing a person is serialised per email (`provision_lock`): two loops
  reaching the same person at once both `POST /admin/users`, and Immich answers the loser
  `duplicate key value violates unique constraint "user_email_uq"`. And `ensure_utility_user` borrows
  the password-login setting only on EVIDENCE — it tries the login first and reads `system-config`
  only after a refusal, because Immich caches that setting and a stale read would restore `disabled`
  over an enable the operator made.

## HTTP surface

Dispatch order in `web/server.rs` is **load-bearing**; each step's position is the reason it is where
it is.

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

`p2p/routes.rs`, in match order. Every route resolves the mapping from the CALLER's key, so a valid
connection can never address someone else's album.

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

## Rules that bite, and how they are enforced

- **`State::collections()` is not reentrant.** It returns a `CollectionsGuard` that PANICS if the
  same thread takes it twice, because the alternative is a silent deadlock that blocks every other
  task while looking like a hang. Bind the guard in its own statement — never as an argument, an
  `if let` scrutinee, or inside a closure.
- **A guard must not live across an `.await`.** The compiler refuses it as a non-`Send` future;
  `clippy::await_holding_lock` names the line. Bind what you need from the guard, drop it, then
  await.
- **The Docker build context is the REPO ROOT**, not ``: `web/assets.rs` embeds the built UI
  with `include_str!("../../../src/web/dist/…")`. Build with `docker build -f Dockerfile .`.
- **`/tmp` is not shared with the Docker daemon.** A file a container writes to a bind-mounted `/tmp`
  lands in the daemon's `/tmp` while this shell reads its own — so a state database "copied to /tmp"
  reads as empty and the failure looks like a compatibility bug. Keep rig state under `target/`.
- **The sidecar image has no Node.** Nothing in it may shell out to `node`, and no test harness may
  assume it can: the rig runs its probes from a separate Node image (`immich-shared-albums:probe`).
- **A nudge is not a sweep, and must not be gated like one.** `handle_invitations_nudge` starts
  `pull_invitations_soon`, which is deliberately outside `sweeps_are_paused`: the browser lane holds
  every sweep and then proves a person's invitation still reaches an already-open panel. A nudge that
  only *records* itself answers `{ok:true}` and changes nothing.
- **`Client` paths are relative to `{ISA_IMMICH_URL}/api`.** Passing `/api/…` builds `/api/api/…`,
  which Immich answers `404 Cannot POST /api/api/...`. `refuse_doubled_api_prefix` refuses it instead.

## Verification

| Lane | What it proves | Command | Expected |
| --- | --- | --- | --- |
| Unit | pure logic, exactly | `cd rust && cargo test --lib` | `255 passed; 0 failed; 1 ignored` |
| Lint | the guard rules above | `cd rust && cargo clippy --all-targets` | no errors |
| Image | the container contract: uid 1000, `/data` writable and owned by it, `HEALTHCHECK` healthy, the identity survives a restart | `bash verify/verify-image.sh` | `PASS — image contract holds` |
| Panel | the sidecar's own panel signs in and renders, with the sidecar fronting Immich on one origin | `bash verify/verify-panel.sh` | `5/5 checks passed` (incl. the "Create a link" button the install docs name) |
| Rig | cross-household behaviour against live mock Immich stacks | `ISA_DOCKERFILE=Dockerfile bash demo/run-mock-e2e.sh` | `ALL PASS (273 checks)` |
| Browser | the banner, the accept page, the chooser, the settings card and the panel's live flows in Chromium | `cd demo/e2e && CKEY=… B_EMAIL=admin@e2e.local B_PASS=… node browser-test.mjs` | `BROWSER PASS (61 checks)` |
| Install | `deploy/install.sh` runs end to end and produces a working install | `bash verify/verify-install.sh` | `PASS — install.sh installed Dockerfile end to end` |
| Mesh | SYMMETRY: the same join/contribute/comment/trail/leave cycle on every ordered pair of a three-household mesh, both directions | `HAND_BIND=<host> bash demo/hand-test-up.sh`, then `node target/probe-mesh-asymmetry.mjs` | `48/48`, and no pair failing where its reverse passes |

Focused lanes in ``, one flow each. The counts are from a run against the live rig; the
container-based ones start their own sidecar unless they say otherwise.

| Lane | Checks | What it pins | Needs |
| --- | --- | --- | --- |
| `frame-interop.mjs` | 10/10 | the `isa/2` framing codec against `demo/e2e/iroh-client.mjs`, the independent JavaScript implementation the e2e suite itself uses | `cargo build --example frame_server`, `ISA_ROOT=<repo>` |
| `peer-interop.mjs` | 9/9 | a real JS iroh endpoint dials the Rust endpoint: handshake, features, the caller's identity from the connection, Range and body bytes verbatim, 404 for an unknown route | `cargo build --example peer_server` |
| `verify-refs.mjs` | 21/21 | a JS peer pushes a ref into the real `isa` binary: the stub's owner, size, aspect, capture date, GPS, rating and credit line | self-hosting, `BKEY` exported |
| `verify-sync.mjs` | 16/16 | the pull side: the version token's shape, manifest, `/status`, entitlement from a pull, and 410 GONE (not 404) after a leave | a sidecar on `:9410`, `BKEY` exported |
| `verify-bytes.mjs` | 10/10 | the byte routes and the entitlement gate: an offered asset IS readable, an unshared one is 403, an invented asset id is 403, an unknown peer is 403 | a sidecar on `:9410`, `BKEY` exported |
| `verify-redeem.mjs` | 25/25 | the enrolment path and every gate that can refuse it: a reused link, an unknown key, a password-gated link with no password or the wrong one, a malformed body, and the setting that turns link joining off at the PEER route as well as on the page | a sidecar on `:9410`, `BKEY` exported |
| `verify-pairing.mjs` | 17/17 | two sidecars pairing over the real wire: single-use links, replay refused, stale refused, both sides listed, the protocol the peer advertised | two sidecars on `:9410`/`:9420` |
| `verify-interceptor.mjs` | 10/10 | `/api/assets/:id/thumbnail` across two servers: a MISS comes from the owner byte for byte, a repeat is a cache HIT | self-hosting, `BKEY` exported |
| `verify-share.mjs` | 13/13 | the join card in Chromium over the framed native album, `?native=1` untouched, dismissal handing over to Immich | a sidecar on `:9400`, `SHARE_KEY` and `SHARE_ALBUM` exported, a screenshot path under `target/` |
| `verify-share-browser.mjs` | 7/7 | `deploy/INSTALL-AI.md`'s VERIFY step 2 on its own: the card only exists once `share.js` has mounted, so a browser is the only thing that can answer it | a sidecar on `:8391`, `BKEY` exported |
| `verify-join.sh` | pass | the MEMBER half of the handshake against a real origin: a refused join pins no peer, a re-dial does not enrol twice, a password-gated album asks for a password | the rig |
| `verify-leave.sh` | pass | the purge reclaims the space: the stand-in's stub is gone, the mapping is gone, and the admin key could never have seen it | the rig |
| `verify-leave-route.sh` | pass | `POST /leave` reaches the engine, and the admin gate in front of it holds | the rig |
| `verify-image.sh` | pass | the container contract: uid 1000, `/data`, `HEALTHCHECK`, identity across a restart | the image |
| `verify-install.sh` | pass | `deploy/install.sh` end to end, through its prompts: health, the 600 `.env`, uid 1000, the panel's 401, Immich pass-through | the rig |
| `verify-panel.sh` | 5/5 | the panel signs in and renders through ONE origin, offers the "Create a link" button the install docs name, and logs no page errors | the rig |

## Performance

Measured as the artefact that ships: one container, against the same mock Immich, with a keep-alive
client (`verify/bench-latency.mjs` — 2000 sequential requests and 2000 concurrent, 50 in flight, per
endpoint). `verify/bench.sh` spawns a `curl` per request, so its latency means are dominated by process
spawn and are not quoted here.

| Metric | Value |
| --- | --- |
| Image size | 9.7 MB |
| Cold start to a healthy answer | 0.320 s |
| RSS, idle | 6.6 MB |
| RSS, after 300 requests | 7.1 MB |
| Threads | 10 |
| `/health` mean / p50 / p95 ms | 0.19 / 0.18 / 0.27 |
| Embedded bundle mean / p50 / p95 ms | 0.20 / 0.17 / 0.36 |
| Passthrough mean / p50 / p95 ms | 0.41 / 0.36 / 0.70 |
| `/health` throughput | 10134 rps |
| Passthrough throughput | 5559 rps |

The binary grows 0.4 MB under that load.
