# `web/` — HTTP surface

The single process's one HTTP entry point and the HTML it serves — for humans and the stock app only; peer traffic rides iroh (`p2p/`).

| File             | What it does                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/server.rs`      | The router: a thin dispatch table mapping each path to a handler. Exports `server`; `main.rs` calls `.listen()`.                                                                                                                                                                                                                                                          |
| `web/passthrough.rs` | The transparent fall-through proxy to Immich for anything that isn't a sidecar route (SPA bundles, `/api`, `?native=1` share pages). Pure stream both directions — it buffers and rewrites nothing; uploads must never be buffered here.                                                                                                                                   |
| `web/upgrade.rs`     | Websockets and any other protocol upgrade, piped at the socket level. Separate from `web/passthrough.rs` because `fetch()` cannot carry an upgrade at all: these never reach the router, arriving on the server's `upgrade` event instead. Two transports, two files.                                                                                                          |
| `web/assets.rs`      | Reads the committed `dist/` artifacts once, rewrites the route prefix, and fills each document's `%%TOKENS%%` with escaped per-request values (household name, og tags, the sign-in reason). The only server-side code that touches HTML, and it contains none.                                                                                                            |
| `ui/`            | The whole front-end, one Preact workspace: `src/web/ui/lib/Document.tsxx` (the single document every page prerenders into), `src/web/ui/lib/theme.ts`, `src/web/ui/lib/confirm.tsxx` (the one confirmation every acting screen asks through), and `pages/{panel,accept,share,sign-in}` — each page is TSX components plus a real `.css` file. `scripts/build-web.mjs` bundles and prerenders it into `dist/`. |
| `dist/`          | Committed build output — `<page>.js`, `<page>.css`, prerendered `<page>.html`. Committed so the Dockerfile stays seven lines with no build step; the pre-commit hook rebuilds and stages it, and CI fails on drift.                                                                                                                                                        |
| `web/auth.rs`        | Who is calling a human-facing route. Forwards the caller's own Immich credentials (session cookie or API key) to Immich's `/users/me` and believes the answer. The sidecar has no accounts of its own and must never invent any.                                                                                                                                           |

## Who may call what

Every route here can be published to the internet, so reachability is never permission.
There are three tiers, and each is enforced server-side:

| Tier            | Routes                                                                                                                                                                                                                                    | Gate                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public          | `/immich-shared-albums/health`, `/immich-shared-albums/accept`, `/immich-shared-albums/assets/*`, `/share/:key` (the join document; `?native=1` passes through)                                                                           | none — liveness, static pages and their assets. `health` returns `{ok:true}` and nothing else, because the join card probes it cross-origin to discover a sidecar.                                                                                                                                                                                                     |
| Signed-in human | `/immich-shared-albums/join`, `/leave`, `/peers`, `/pairings`, `/pairings/revoke`, `/pair`, `/settings`, `/unlink`, `/me/albums`, `/me/matches`, `/me/preferences`, `/me/albums/publish`, `/me/reunite`, `/me/unreunite`, `/me/invite`, `/events`, the panel | `web/auth.rs` against the caller's Immich session. `join` takes the account from the **session**, not the request body; naming a different user requires admin. `/me/invite`, `/me/reunite`, `/me/unreunite` and the panel are caller-scoped, not admin: they act on the caller's own albums. The rest requires admin — server links and settings are admin-owned objects. |
| Peers           | **nothing** — peer operations left HTTP entirely and ride mutually authenticated iroh QUIC; see [`../p2p/wire-protocol.md`](../p2p/wire-protocol.md). The router serves humans and the app, full stop.                                    |

The accept page's client-side `whoami` is UX only — it tells someone to sign in before
they fill a form. The server never trusts it.

**Two ordering rules in `web/server.rs`:** route before reading a body (only the sidecar's own
JSON routes are buffered, under `ISA_MAX_BODY_KB`; passthrough traffic including photo uploads
streams through), and authorise before doing work.

## The share document, and the switch that governs it

`GET /share/:key` serves the prerendered share document: `og:` tags for link unfurlers, the
origin's **endpoint token** (so a visitor's sidecar can dial it over iroh), and the join card
over the native album in a same-origin iframe. `?native=1` is the untouched Immich page — what
the iframe loads, and where dismissing the card navigates.

**`/events` is the panels' live channel.** One `text/event-stream` response per open panel, gated
exactly like the panel itself (a session), carrying a `{ type }` hint — `invitations`, `index` or
`shares` — and never any data. The panel's reaction is to re-read `/me/albums` and `/me/matches` as
the caller, so a hint cannot show anyone something they could not fetch themselves, and a sidecar
without the route answers 404 and leaves the panel behaving as it did before. Emitting is
`emitPanelEvent` from `web/server.rs`, which the sync and peer layers call when a nudge arrives or
a share changes. **Every emit is gated on the change it announces** (`indexChanged` before hinting
`index`, `changed` before `invitations`, the write itself before `shares`): the panel's own re-read
goes back through those same refresh paths, so an ungated hint tells a page that just asked to ask
again, for as long as it stays open. `/sync/status` answers the running total as `hints`, which is
how the browser lane asserts an idle open panel is not doing that.

**`/immich-shared-albums/` is the chooser.** It is the one URL worth remembering, so it is gated on a
session rather than on admin: it asks Immich who is calling (`src/web/ui/pages/root/App.tsxx`) and either opens
the personal panel directly (anyone) or offers the two panels (an admin). The admin panel lives at
`/admin` because a choice has to point somewhere; `/me` is the personal panel.

**And one is acted on after.** `DELETE /api/albums/:id/user/:userId` is the owner taking a person off
their album, recorded as one short comment naming them (`web/album_member_audit.rs`). `me` is
excluded, because that is a person LEAVING, which is a different event with its own line.

**Every audit line is one sentence: who, what happened, full stop.** The consequence is not posted —
whether removing a person revoked anything depends on the kind of share (an invitation's membership
IS the share; a link's is not — see "bearer grant" above), and that reasoning belongs here rather than
in somebody's album.

**A share can also end SILENTLY, and the survivor records it.** A peer that unlinks us (or loses its
sidecar) stops answering, and nothing on this side changes — so the invite loop asks one `/version`
handshake per live share, and 403/404 answers feed the same retirement counter the push uses
(`sync/engine.rs::retire_dead_share`). The survivor writes the line into its own album, because this
side still owns it and can put the bot on it.

**One proxied request is acted on before it is forwarded.** `DELETE /api/shared-links/:id` is the
only write whose trail needs the state it is about to destroy: the album it granted is read first, as
the caller, and the withdrawal is written into that album afterwards by the house bot — added on the
caller's own credential, because the household admin key cannot touch an album it does not own
(`web/share_link_audit.rs`).

**One proxied answer is rewritten, for one reader.** `GET /api/activities` is the album's comment
history, and it is the only route where the passthrough looks at the body: a caller who has turned
`auditVisibleInComments` off (their own row, `/me/preferences`) gets the addon's own lines dropped
from THEIR answer (`web/activity_filter.rs`). The rows stay in Immich, stay in every other reader's
view, and stay in the album. The tag written when a line was posted is what the filter matches —
never the author, because the relay posts another household's comment as a stand-in and falls back to
our own bot.

**A panel visit also drains the waiting trail.** `GET /me/albums` is the moment a person is in front
of us with the credential that can authorise a membership on their OWN albums — so it is where audit
lines queued while they were away (a peer's join, a peer's leave) are finally written
(`sync/trail.rs`). Detached from the answer, so a panel never waits on the trail.

**The conversation carries likes as well as comments.** `/albums/:id/activity` (the push) and
`/albums/:id/comments` (the canonical read) both carry a `type` on every row — additive, so an older
peer that never reads it gets comments exactly as before. Both the statistics gate and the version
handshake count comments + likes, or a like that moved would never be pulled. Utility accounts'
activity is excluded at the ORIGIN: our bot's lines are this household's trail, not a person for the
peer to mirror.

**The per-user routes answer as the caller.** `/me/albums` and `/me/matches` read Immich with the
caller's own forwarded credential (`immich/access.rs` decides that once), so membership and
ownership are Immich's answers rather than a filtered admin read — and `/me/albums/publish` reads
the albums from Immich too, so a request body can only name the peer it is offering them to.
`/me/invite` is the same rule applied to a write: it re-derives the caller's own album from their list
and the person from the index that peer published, then adds that one membership — the only change
this sidecar makes to Immich on a human's behalf.

Panel settings live in the kv `settings` row: `pairingTtlMinutes` (how long a minted pairing link stays redeemable, default 15, clamped 5–1440 — the ticket itself is shown exactly once and only its hash persists) and `shareLinkJoin` (default on), which governs the
whole capability: off means every `/share/*` request passes straight through **and** the iroh
`/invites/redeem` route answers 403 (`p2p/routes.rs`) — hiding the card without refusing the
join would be a setting that lies.

The element ids `#who`, `#go`, `#out`, `#openapp` and the join card's `#immich-shared-albums-banner .card`/`input`/`button.join`/`.err` are a **test contract**: the browser lane drives
both pages through them, and it is the only end-to-end coverage those flows have.

## Two deployment shapes

**Single front (simplest to install).** Point the reverse proxy at the sidecar and let it
pass everything else through to Immich — one route, no path matching, no ordering to get
wrong. Keep Immich as a second upstream so a dead sidecar fails open:

```caddy
photos.example.com {
	reverse_proxy immich-shared-albums:8300 immich-server:2283 {
		lb_policy first
		fail_duration 10s
	}
}
```

This is the shape the demo rig uses — the phones sign in to the sidecar's origin, because
that is where the byte interceptors live. It also removes every same-origin question at a
stroke: the share document, byte interception and the accept page's session cookie all just
work, because there genuinely is one origin.

**Path-routed (Immich stays the front).** Route only `/immich-shared-albums/*`, `/share/*` and the three
GET byte paths to the sidecar, ahead of the catch-all. More proxy config, and the ordering
matters, but Immich's traffic never traverses the sidecar. See [deploy/](../../deploy/).
