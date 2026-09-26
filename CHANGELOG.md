# Changelog

Versioning: **MAJOR** = a peer on the previous version can no longer sync with you,
or upgrading requires operator action (config/env/proxy changes). **MINOR** = new
features; older peers keep working (they just miss the optimisation). **PATCH** = fixes.
Watch this repo's releases to be notified when an update breaks contract.

## [1.2.0](https://github.com/lukeet332/immich-shared-albums/compare/v1.1.1...v1.2.0) (2026-09-26)


### Features

* bind the peer transport to a stable UDP port ([#71](https://github.com/lukeet332/immich-shared-albums/issues/71)) ([befe01e](https://github.com/lukeet332/immich-shared-albums/commit/befe01e805e575d4eff54aa0ddadbc9389b1a1e4))
* carry the reunified category with the share ([#95](https://github.com/lukeet332/immich-shared-albums/issues/95)) ([de458ac](https://github.com/lukeet332/immich-shared-albums/commit/de458ac2c6f78e2cf893b58481e7a2de9327c994))
* cut the e2e suite from 499s to ~320s by waiting on convergence, not clocks ([#55](https://github.com/lukeet332/immich-shared-albums/issues/55)) ([c83b178](https://github.com/lukeet332/immich-shared-albums/commit/c83b178813ba14464a2348fd25246ef5bf826b02))
* give the personal panel a heading and a way out ([#87](https://github.com/lukeet332/immich-shared-albums/issues/87)) ([760a8f8](https://github.com/lukeet332/immich-shared-albums/commit/760a8f85f215b5ad11d76f63c28476ab72c1b654))
* invite and accept a reunion from the panel ([#113](https://github.com/lukeet332/immich-shared-albums/issues/113)) ([6a537fd](https://github.com/lukeet332/immich-shared-albums/commit/6a537fdcac6c705e1b3462a2e6a67f036480f23b))
* match two people's split albums by name, owner and dates ([#81](https://github.com/lukeet332/immich-shared-albums/issues/81)) ([1daa7f7](https://github.com/lukeet332/immich-shared-albums/commit/1daa7f79122bdc78b47067de27d4724ddff8fd25))
* one root URL that opens the right panel ([#88](https://github.com/lukeet332/immich-shared-albums/issues/88)) ([cd32f9a](https://github.com/lukeet332/immich-shared-albums/commit/cd32f9af2995f17a2bed30b8a2110bb9d05da0d3))
* per-user panel scaffold (/me) — keystone for reunification ([#49](https://github.com/lukeet332/immich-shared-albums/issues/49)) ([c756ba6](https://github.com/lukeet332/immich-shared-albums/commit/c756ba68f6804334143fb01f9a2ab44ff377b827))
* port the sidecar to Rust and ship it by default ([6ee6a2e](https://github.com/lukeet332/immich-shared-albums/commit/6ee6a2e8a0588b972768b58fd0e304712d1bd728))
* publish a person's owned albums so a linked peer can match them ([#82](https://github.com/lukeet332/immich-shared-albums/issues/82)) ([4e79bdd](https://github.com/lukeet332/immich-shared-albums/commit/4e79bddc3a60bb59e810a707ac80bae96326ef79))
* record that an album is reunified, and never delete an adopted one ([#93](https://github.com/lukeet332/immich-shared-albums/issues/93)) ([f05ed7b](https://github.com/lukeet332/immich-shared-albums/commit/f05ed7b6e84b0362b6057ef42d7eaec50e5892c1))
* reunite partial albums from the panel ([#102](https://github.com/lukeet332/immich-shared-albums/issues/102)) ([0a2496c](https://github.com/lukeet332/immich-shared-albums/commit/0a2496cddb5f5212471153de657be3210fe60dfc))
* seed an adopted album's ledger, so none of it is offered back ([#91](https://github.com/lukeet332/immich-shared-albums/issues/91)) ([0b90c1e](https://github.com/lukeet332/immich-shared-albums/commit/0b90c1e2c4ee91ace01f5be13cf00a0f4d3f312f))
* show possible reunions in the per-user panel ([#83](https://github.com/lukeet332/immich-shared-albums/issues/83)) ([b042ee5](https://github.com/lukeet332/immich-shared-albums/commit/b042ee536ece38777c4e3640297e309d76225bc2))
* tell a person whether it worked ([#115](https://github.com/lukeet332/immich-shared-albums/issues/115)) ([92d8842](https://github.com/lukeet332/immich-shared-albums/commit/92d8842ac27d6123aed8e2dd5cfde2310040c2a9))
* the admin panel asks through the same dialog, and says less ([#118](https://github.com/lukeet332/immich-shared-albums/issues/118)) ([817a69a](https://github.com/lukeet332/immich-shared-albums/commit/817a69a2c1a3c0c843acb3200cf0070d55670aa6))
* the reunion flow is nudge-driven, and open panels follow it ([#128](https://github.com/lukeet332/immich-shared-albums/issues/128)) ([beff0cc](https://github.com/lukeet332/immich-shared-albums/commit/beff0cc9114bcf27a4f1bf78ed6328f068d0356f))
* the wire oracle is a Rust example ([02faa3e](https://github.com/lukeet332/immich-shared-albums/commit/02faa3e3e793928621f8a12f65b9675bfb0d5c8b))


### Bug Fixes

* a person's stand-in keeps their own face, and our bot names itself ([#125](https://github.com/lukeet332/immich-shared-albums/issues/125)) ([fa9d926](https://github.com/lukeet332/immich-shared-albums/commit/fa9d92602e453906b2ecaa69b7cb699b4eef22be))
* a photo Immich has not measured is never mirrored as a square stub ([#130](https://github.com/lukeet332/immich-shared-albums/issues/130)) ([2458939](https://github.com/lukeet332/immich-shared-albums/commit/2458939aa647566029541880e0d29b04db821f67))
* a reunion hands the other half over at once, not at the next sweep ([#129](https://github.com/lukeet332/immich-shared-albums/issues/129)) ([658b994](https://github.com/lukeet332/immich-shared-albums/commit/658b994518a1709ec176e1a09901e3345f8c5971))
* a reunion merges both ways, instead of only into the side that accepted ([#123](https://github.com/lukeet332/immich-shared-albums/issues/123)) ([7f779ca](https://github.com/lukeet332/immich-shared-albums/commit/7f779ca19d538cfea99ed61d1c145f97f4afb411))
* answer a proxied rejection instead of hanging the caller ([#109](https://github.com/lukeet332/immich-shared-albums/issues/109)) ([f9a68a3](https://github.com/lukeet332/immich-shared-albums/commit/f9a68a3833334e0bfef9284c8a067dbbf86941c2))
* **e2e:** reset sidecar state properly, and fail fast when the rig is dirty ([#57](https://github.com/lukeet332/immich-shared-albums/issues/57)) ([8a2d30b](https://github.com/lukeet332/immich-shared-albums/commit/8a2d30bff756dae82e5f45faad27134fb4d847f8))
* exit on SIGTERM so a container stop does not wait out its grace period ([#60](https://github.com/lukeet332/immich-shared-albums/issues/60)) ([700283c](https://github.com/lukeet332/immich-shared-albums/commit/700283c2e1319c12e7364d1e98b1145c2c3c78cb))
* give a peer dial its own 10s budget so an offline owner fails closed fast ([#64](https://github.com/lukeet332/immich-shared-albums/issues/64)) ([f0ada02](https://github.com/lukeet332/immich-shared-albums/commit/f0ada0212f556d351b3eae4b86c234d2011a3fca))
* hand Immich the bare share path, so the framed album keeps its metadata ([#106](https://github.com/lukeet332/immich-shared-albums/issues/106)) ([a5d31bb](https://github.com/lukeet332/immich-shared-albums/commit/a5d31bb01701e3c3570a7de71d45d516f69e9787))
* name the album-reunion problem in the reader's terms ([#86](https://github.com/lukeet332/immich-shared-albums/issues/86)) ([85d1e76](https://github.com/lukeet332/immich-shared-albums/commit/85d1e761558b4ef437b6760acfb8b80f7712c9db))
* never offer a photo whose owner the user cache has not seen ([#73](https://github.com/lukeet332/immich-shared-albums/issues/73)) ([082190a](https://github.com/lukeet332/immich-shared-albums/commit/082190aa805b1aa9d3bc18a17413b553383581af))
* per-user panel reads the caller's albums as the caller ([#78](https://github.com/lukeet332/immich-shared-albums/issues/78)) ([e197972](https://github.com/lukeet332/immich-shared-albums/commit/e1979722e4f03d6e3dcf6155d761558476733933))
* record an accept-flow reunion as reunified, and stop offering one already made ([#108](https://github.com/lukeet332/immich-shared-albums/issues/108)) ([982cb7b](https://github.com/lukeet332/immich-shared-albums/commit/982cb7ba2203651d48f32fdcc49bdaecfe2bd173))
* refuse to provision a utility account for a server being unlinked ([#72](https://github.com/lukeet332/immich-shared-albums/issues/72)) ([2592890](https://github.com/lukeet332/immich-shared-albums/commit/259289059d7ef34539981f00bd987bb0b524dbba))
* retire a mapping whose peer keeps answering 404, and stop logging every retry ([#74](https://github.com/lukeet332/immich-shared-albums/issues/74)) ([3bb6ac8](https://github.com/lukeet332/immich-shared-albums/commit/3bb6ac850913d08c137f5ed4fdd240c09c917012))
* show one reunion row per pairing a person can tell apart ([#112](https://github.com/lukeet332/immich-shared-albums/issues/112)) ([e382689](https://github.com/lukeet332/immich-shared-albums/commit/e3826891ab632870e921efe938988f67a529301c))
* stop matching against a peer's albums once it withdraws them ([#107](https://github.com/lukeet332/immich-shared-albums/issues/107)) ([1465ba0](https://github.com/lukeet332/immich-shared-albums/commit/1465ba0678c8e4a5752ae01f7e7070c2ecd9953c))
* stub bytes are served only to callers Immich itself would serve ([#156](https://github.com/lukeet332/immich-shared-albums/issues/156)) ([a8523e2](https://github.com/lukeet332/immich-shared-albums/commit/a8523e2bea88c16c8cd4bee81bfbd3d5bc51bad2))
* the album's trail records an un-reunite ([#126](https://github.com/lukeet332/immich-shared-albums/issues/126)) ([77fdafa](https://github.com/lukeet332/immich-shared-albums/commit/77fdafa52e3bc2aac4e601b1c2c2276d11e10501))
* the installer proves the key, names its volume, and tells the truth about itself ([113df10](https://github.com/lukeet332/immich-shared-albums/commit/113df1054f68f4bb45c7c3581372cd84b3f79521))
* the invitation stage reads its mirror through the narrowing, not through a throw ([00a3083](https://github.com/lukeet332/immich-shared-albums/commit/00a3083575872c85066ff744efcc97dcd1061722))
* the panel offers the undo only where it works, and fits a phone ([#121](https://github.com/lukeet332/immich-shared-albums/issues/121)) ([84cde33](https://github.com/lukeet332/immich-shared-albums/commit/84cde33ae6301b288d5c92b444d29738c2326dbc))
* the signed-out pages lose their theme, and claim work that is not happening ([#119](https://github.com/lukeet332/immich-shared-albums/issues/119)) ([3813856](https://github.com/lukeet332/immich-shared-albums/commit/381385679234cc3f7c8d3bbd3ca0f1d1d054abd6))
* the silent-share handshake counts CONSECUTIVE failures ([b6f083e](https://github.com/lukeet332/immich-shared-albums/commit/b6f083e36bb08383d30c193faf28fbd4759573a5))

## [1.1.1](https://github.com/lukeet332/immich-shared-albums/compare/v1.1.0...v1.1.1) (2026-09-17)


### Bug Fixes

* member-side mirrors read with the utility key, not the admin key ([#51](https://github.com/lukeet332/immich-shared-albums/issues/51)) ([1d0185b](https://github.com/lukeet332/immich-shared-albums/commit/1d0185b561a337eae97d47127c3de77d0424bfcc))

## [1.1.0](https://github.com/lukeet332/immich-shared-albums/compare/v1.0.2...v1.1.0) (2026-08-26)


### Features

* admin toggle to store shared assets locally ([#45](https://github.com/lukeet332/immich-shared-albums/issues/45)) ([5bb197e](https://github.com/lukeet332/immich-shared-albums/commit/5bb197e40b6e5c349105e7adc6b5239a56f5ea68))

## [1.0.2](https://github.com/lukeet332/immich-shared-albums/compare/v1.0.1...v1.0.2) (2026-08-26)

> Manual release: release-please cannot cut releases while the reserved-immutable `v1.0.0` tag
> blocks it (same reason 1.0.1 shipped by hand). Contents are the two post-v1 fixes below.

### Bug Fixes

* bot accounts use the `.internal` email domain instead of `.invalid`, which read as an error to end users; legacy-aware and migrated on startup ([#42](https://github.com/lukeet332/immich-shared-albums/issues/42))
* cross-server mirror stubs now carry the origin photo's aspect ratio instead of a fixed 1×1, so mirrored photos lay out correctly in the grid and viewer ([#43](https://github.com/lukeet332/immich-shared-albums/issues/43))

## [1.0.1](https://github.com/lukeet332/immich-shared-albums/compare/v0.5.0...v1.0.1) (2026-08-25)

> Note: v1.0.0 was never published — the tag was reserved by an earlier reverted release
> (GitHub immutable releases), so the first v1 release ships as 1.0.1. Contents below are the
> full v1 changeset.



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
