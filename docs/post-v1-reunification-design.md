# Post-v1 design spec: Google shared-album reunification & the user-level surface

> Status: **the merge is built end to end.** §2's match and both surfaces exist — `sync/matches.ts`
> pairs the halves, `sync/album-index.ts` records what each side offers, the per-user panel lists
> matches and reunites each one (`POST /me/reunite`, reversing with `/me/unreunite`), and the accept
> flow asks before it acts (`POST /join/preview`, then `POST /join` with `adopt`). §3's suppression
> is scoped to the album (`sync/album-suppression.ts`), and §7's trail is left in the album's own
> comments by `sync/audit.ts`. `/commands` remains design. Everything here is post-v1 and confirmed
> **non-breaking** — it rides surfaces and identities that v1 already ships and freezes. Captured
> from the 2026-08-25 design discussion. Decisions are marked **[decided]**; open choices
> **[open]**; things considered and dropped are in "Rejected alternatives" with rationale.

## 1. Why this is possible without breaking changes

None of this needs a wire, ticket, or schema break. The foundation v1 froze is already the right
shape:

- **A photo's cross-server identity is its content checksum**, not any server-assigned id
  (`seen` ledger keyed by `(mapping, checksum)`; the manifest carries both `checksum` and the
  origin's current `originAsset`).
- **The version handshake compares by equality, not ordering** — a rebuilt/rewound server never
  confuses a peer.
- **The schema has a version stamp** (`PRAGMA user_version`), so any helper columns these features
  want are additive migrations.
- **The wire evolution rules** (`wire-protocol.md`): unknown JSON fields are ignored, unknown
  routes 404. So new peer routes and new optional `AssetRef` fields (e.g. dedup metadata) are all
  additive.

---

## 2. The core feature: reuniting a former Google shared album

### The scenario

Two people (e.g. a user and their parent) were in the **same Google Photos shared album**. Each
migrates independently via **Google Takeout + immich-go** and lands with a _partial_ album of the
same name:

- Only the assets **they** owned, plus any shared ones **they had saved** to their own Google
  storage.
- Two albums, same name, **overlapping-but-incomplete** contents.
- **No immich-shared-albums relationship ever existed** — the album lived on Google.

### The goal

Link the servers and, with consent, **merge the partial halves back toward the album's original
Google state.**

### Why the end-state is already what our model produces

A `contribute` share already yields the target shape: **each side sees the full union, owns its own
contributions as real photos, and holds the other's as hotlink stubs.** So the sync _primitives_
(contribute-push, materialise, manifest, reconcile) already exist. The novel orchestration is:

1. **Match** the two partial albums (name + metadata + creation date + **owner** — see §4).
2. **Adopt** each side's _existing populated_ album as the mapping — rather than the normal "join
   creates a fresh empty mirror" — so nobody ends up with two copies of the album.
3. **Bidirectional initial contribute** with non-destructive dedup (§3).

Each person **stays the owner of their own album**. Neither album is copied, transferred or
re-created, so no step ever produces a second album on either server: the album you own is the
album that changes, and the mapping that carries the share points at it (§4).

### Honest ceiling

"Exact original Google state" is **best-effort**. Google Takeout re-encodes/strips EXIF per export,
so the _same_ shared photo exported by both people can arrive with **different bytes → different
checksums**. Reunification converges to "very close, deduped where content or metadata agree," not
guaranteed pixel-identical where Google diverged the copies.

---

### The accept flow offers the reunion, it does not assume the join **[decided]**

A late reunifier is the person this design is most likely to meet: they accepted a share for an album
they already hold half of, and a plain join would leave them with **two albums of one name** — the
duplicate the feature exists to remove. So the accept surface asks before it acts:
`POST /join/preview` answers whether this household already owns an album of the link's name
(`findAdoptableAlbum`, the same function `unifyOwnAlbum` re-derives server-side, so a preview can
never offer a marriage the adoption would refuse). The page then offers "reunite with your album" and
passes `adopt` to `POST /join`, which is the path that already exists and is validated against the
caller's own list rather than the browser's word.

**The preview does NOT redeem the link, and that is the whole constraint on it.** Redeeming is not a
read: it pins the caller as a peer on the ORIGIN and writes an owner mapping there. A preview that
redeemed would enrol a household on someone else's server merely because a page opened. So the album
name travels the other way — the share page already knows it and puts it in the accept link, and the
preview needs nothing else. An older share page that sends no name simply offers no reunion, and the
person lands in an ordinary share with the panel (§5) to reunite the two halves there.

Sign-in is required, as it is for `/join`: the comparison is made with the caller's credential,
because only Immich can answer which albums they own, and a caller who is not signed in has nothing
to compare against. Without a preview a late reunifier still has the panel (§5) — they land in an
ordinary share with a second album, and reunite the two there — so the preview is about not creating
the duplicate in the first place, not about the only way out of it.

## 3. Dedup: non-destructive suppression **[decided]**

The key design decision that de-risks the whole feature: **dedup is never destructive.**

For a photo **both** servers own, don't delete and don't hotlink — **each side represents it with
its own local real asset and suppresses the incoming ref** (never materialise a stub for it).

- **Symmetric & coordination-free:** Alice uses Alice's copy, Bob uses Bob's, independently.
- **Self-sufficient:** no online-dependency on the peer for photos you already hold.
- **Reversible:** un-suppress = reveal/materialise the incoming stub so both show ("un-dedupe").

### Why this is the unlock

With _destructive_ dedup, a false-positive match loses a photo, so matching would have to be near-
perfect (impossible across mangled Takeout exports). With **non-destructive suppression, both error
directions are cheap and reversible:**

- A **miss** → a redundant hotlink stub of a photo you already own. Harmless.
- A **false positive** → one photo temporarily hidden, undoable. No loss.

So cross-server match precision becomes a **soft optimisation, not a correctness requirement.**

### Suppression is scoped to the ALBUM, not the mapping **[decided]**

A mesh can offer one photo through two shares that land on the same album — three households holding
the same Google album is the case this design exists for. Suppressing per mapping would materialise
two stubs for it, and Immich cannot collapse them, because each stub carries a random tail so that it
is a distinct asset. `existingCopyInAlbum` (`../src/sync/album-suppression.ts`) therefore asks
whether _the album_ already holds the photo, whichever mapping put it there, and `materialiseRef`
records the row against the second mapping rather than uploading again. Two ledger rows then carry
one stub, so withdrawing one share's copy leaves the other's claim standing.

### It also dissolves ownership ambiguity for co-owned assets

For photos **both** own, ownership is moot — each uses its own copy. Ownership only has to be
resolved for photos that live on **one** side (those get the normal owner→member hotlink).

### Matching signals (merge-time, ours to control)

Match an incoming ref to a local asset by:

1. **Checksum** where the original bytes survived Takeout.
2. Else **Takeout metadata** immich-go writes: original filename + `takenAt` + dimensions. These
   would be added as **optional `AssetRef` fields** (additive, legal under evolution rule 1).

Normalise for recall (lowercase/trim), and **use the Google album date, not the import date.**

### Already safe

Deletion propagation only ever touches **bot-owned stubs** (`deleteProxyAsset` refuses non-bot
assets), so an **adopted user-owned copy is never auto-deleted.** The v1 guard already covers the
"no lost data" requirement.

### Trade-off

Adopted copies are **independent** — a later edit/caption on one side won't propagate the way a
hotlink would. Fine for historical reunited photos; worth stating.

---

## 4. Ownership & matching metadata **[decided]**

### The normal model

A shared album has **one owner** (real photos, `role: 'owner'`) and **members** (stubs,
`role: 'member'`). Ownership was a deliberate act (the inviter), recorded only in `state.db`.

### The ambiguity Takeout creates

Takeout **flattens the two distinctions the model depends on** — owner-vs-recipient, and
my-photo-vs-shared-with-me. A restored server can hold _real copies_ of photos it only held as
stubs, and every restored server looks like an owner of everything (bots/stubs never export).

### Resolution

- For **reunification**, ambiguity is resolved by **consent** — it's an owner-to-owner
  request→accept (§6), so nothing is guessed.
- For the **lost-`state.db` restore subset** (§9): ownership survives as long as **one** side kept
  its record; on re-pair, whichever still holds `role: 'owner'` re-asserts it. Only if **both**
  lost it is ownership truly gone → a human "who owns this?" decision. Never machine-guessed.

### Each person keeps their own album **[decided]**

Immich has no ownership transfer, and the sidecar's only way to make someone a "member" of an
album is to create a mirror album owned by a stand-in account (`ensureMirror`). So a reunification
that re-assigned ownership would have to **create a second album on one server** — the duplicate
the feature exists to avoid. Instead:

- **The album's own owner stays its owner**, on their own server. Nothing is transferred, and no
  album is created for the merge.
- The peer's photos materialise into that album as **stand-in-owned stubs**, exactly as a
  `contribute` share already does — so one album legitimately holds the owner's real photos _and_
  the other person's stubs. Ownership of a real photo never changes hands.
- **Overlaps are suppressed, not resolved**: a photo both sides hold stays each side's own real
  asset, with no stub for the peer's copy (§3). That is what keeps the union from double-showing.
- Consequence: no alias account is mirroring a person here. The merge writes **only the stub
  assets** into the album, and attribution stays on the ref (`contributor.originUserId`), so no
  Immich account is created for a person we have not been asked to share with.

### Only the album's owner can add its writers **[decided]**

Adopting an album does not make the sidecar able to administer it. Immich scopes membership writes to
the album's owner: the household admin key answers `403 albumUser.create` on an album a different
person owns, and a viewer — which is what the house bot is — does too. So the accounts that will own
the merged stubs (`person-<originUserId>`, one per contributor named by the peer's refs) are granted
membership as **editors** at adoption, on the album owner's forwarded credential:
`grantAlbumWriters` in [`../src/sync/album-grant.ts`](../src/sync/album-grant.ts), called from
`ensureMirror`'s adopt branch and from `unifyOwnAlbum`. A reconcile that runs later holds no owner
credential, so a contributor the peer only begins offering afterwards needs the owner in the loop
again — that is the panel's job, not the loop's. Un-reunifying runs on that same credential, so it
takes those accounts back off (`stripAlbumBots`): a membership left behind would both keep the
sidecar's read access to a private album and make it indistinguishable from a live mirror.

### What a side publishes, and what "owned" means **[decided]**

Matching runs against albums each side **owns** — never ones merely visible to them.

- "Owned" is `albumUsers` containing the caller at `role: 'owner'`. An album response carries no
  `ownerId`; the owner is only inside `albumUsers`.
- Owned-only is sufficient because Takeout **flattens ownership**: the Google Photos importer
  creates an Immich album per Google album through _your_ API key (`--sync-albums`, default on), so
  a Google album that was someone else's arrives in your library as an album you own.
- Owned-only is also the minimal disclosure, and it cannot publish the same album twice when two
  local people are both members of it.

### The album owner must travel in the match metadata

Match metadata is **name + date + metadata + OWNER**. The owner field is required because:

1. **It scopes the match to a user, not the server** — the match shows only in _that owner's_ user
   panel, not server-wide or to the admin.
2. **It routes the request owner-to-owner** (Alice's "Summer 2024" owner → Bob's owner).

Owner-sharing **rides the existing directory exchange** (linked servers already share user
identities), so it's no new identity disclosure — but album matching therefore **depends on the
directory being shared** (directory off → owner can't travel → can't match/route).

---

## 5. The four-surface model **[decided]**

Each surface has exactly one job:

| Surface                               | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin panel**                       | _Server-owned_ config: pair/unlink, server settings, API key, the "allow shared album recovery" toggle.                                                                                                                                                                                                                                                                                                                                                                                   |
| **User panel** _(new — the keystone)_ | _My_ stuff: albums shared with/by me, the **matches list**, and the action each row carries — **Invite** (`POST /me/invite`) when nothing is shared yet, **Accept invite** (`POST /me/reunite`) when the other half arrived as a share, and nothing but a waiting line when the invitation is the one they sent. Per-user settings and a separate pending-requests list are **not built**: the row itself is the request, and accepting is the same `/me/reunite` an accepted share uses. |
| **Native gestures**                   | Share menu = invite, leave album = leave (existing model, unchanged).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Comments**                          | The in-context/recovery escape hatch: discovery nudges, the public audit trail, and `/commands`.                                                                                                                                                                                                                                                                                                                                                                                          |

### The user panel

- **Cheap to build:** reuses `callerIdentity` auth — drop the `isAdmin` gate, scope everything to
  the caller's user id, same page-serving mechanism as the admin panel.
- **Two real tasks:** (a) rigorous per-user authz scoping, fail-closed, never leak another user's
  data or reach an admin op; (b) discoverability — no button can be added to Immich's own app, so
  entry is a bookmarkable URL + contextual links (from the share page we serve, from bot comments).
  Acceptable **because** the common path is automatic/native, so the panel is a
  reach-for-it-when-needed surface, not a required one.
- **Ethos-consistent:** invent a surface only where Immich gives no gesture — the same
  justification the admin panel already has.

---

## 6. Consent, defaults & the repair flow **[decided]**

### Admin gate

**"Allow shared album recovery"** — a server-level toggle, **default ON**, disclosed at link time.

- **Default-on with disclosure**, not opt-in: most people linking servers want this, and opt-in has
  a bad failure mode (miss the popup → feature silently absent → confusion). Default-on fails gently
  (it's on, works, turn off if unwanted).
- The **link-time popup is informational**, not a gate: _"Album recovery is on: linked servers can
  see album names to find shared albums to reunite. Turn off in settings if you'd rather not."_ The
  popup **writes** the durable toggle; the panel keeps the switch.
- **Reciprocal:** each admin's link flow shows it; each consents for their side; if either declines,
  matching is off/one-directional.
- **Caveat (write down, don't act on):** this rests on _trusted family servers_. If the audience
  ever broadens to less-trusted peers, revisit the default.

### The flow **[decided: no auto-merge]**

Albums **never auto-merge.** The flow is always:

1. Matching runs (both sides opted in) and finds candidates.
2. Each candidate surfaces in the **owner's** user panel (scoped by the owner field, §4), and a
   **local bot-comment nudge** is posted (§7).
3. The album owner **invites** — `POST /me/invite` gives the matching owner's account a membership
   on that one album, which is the request. It is the same membership Immich's picker makes, and the
   only sharing action the panel performs.
4. That owner **accepts in their own panel** (`POST /me/reunite`), which moves the share onto the
   album they already own, and their side reports it back with `POST /albums/:mappingId/reunified`
   so the inviter's row leaves its candidate list too.
5. The merge runs with non-destructive dedup (§3); a **public audit trail** is posted (§7).

### Why no auto-merge

An unconfirmed auto-merge is where a **false match** bites (generic names like "Photos"/"2024"
colliding). Keeping owner-to-owner confirmation is exactly where a human catches "those aren't the
same album." Non-destructive + audit trail make even a bad merge reversible, but confirmation is
cheap insurance. _(This supersedes an earlier "always repair / auto-reunite" idea — dropped.)_

---

## 7. Notifications & the audit trail **[decided]**

**Don't build notification infrastructure — lean on Immich's native activity** (iron rule 8).
Consistent pattern throughout: **bot comment = the discovery/notification nudge; user panel = the
actionable content.**

### Match-found nudge

When a match is found, post a **local bot comment** on the owner's album: _"We found a possible
match to reunite this album — view in your panel [link]."_

- _"Only the local user sees it"_ resolves naturally: it's posted on the owner's **own pre-repair
  album**, which for a Takeout import is typically **owner-only**, so it's private by album
  membership — no per-user-comment trick needed.
- Edge case: if the album already has local co-members, they'd see the nudge too — harmless, since
  the comment only says "see your panel" and the match list is behind the auth-scoped panel.
- Bot-authored → already excluded from sync → stays local. Panel link is a URL in the comment
  (copy-pasteable even if Immich doesn't render it clickable).

### Audit trail — **public** in comments

Revised from "pair-private" to **public**: an album's history is legitimate shared context for
everyone in it, like an edit history; members see contents change anyway, so hiding _why_ is the odd
choice. This also removes the wrinkle that **Immich has no native per-user-private comment.**

- **Comments** hold the trail + discoverable prompts: _"Repair requested by X," "accepted by Y,"
  "Repair successful — 3 photos merged by non-destructive dedupe, reply `un-dedupe` to see all."_
- **User panel** holds the actionable bits (pending requests, repair button, settings); a request
  that is **rejected or times out** has a line only there, because it never created an album the
  two sides share, and writing to the peer's album is not something an ungranted request may do.
- **Every line is authored by a utility account** (`ensureContributor`, message posted with that
  account's key). That is what keeps it local: `syncCommentsOnce` drops any comment whose
  `user.id` is in `utilityIds` before pushing, so the trail cannot cross servers or echo back. A
  line authored as the human who clicked would sync as that person's comment onto the peer's album.
- **Each side posts its own copy** as the coordinated event completes — both servers know the
  request, the accept, the merge and the withdrawal from the peer protocol, so no trail line is
  ever transmitted. Each side's comment thread ends up showing the same events.
- **Idempotent by ledger, not by hope**: a line is written once per event, tagged through
  `seenActAdd`/`seenActHas`, because the loops retry a step until it settles and a naive write
  would accumulate a second "Repair requested by Alice" on every pass. `sync/audit.ts` is where this
  lives: `auditLine(mappingId, albumId, event, text)` writes the tag for the event and a `local:` tag
  for the activity it posted, so the line is neither repeated nor pushed back to the peer.
- **The reunion's line is posted at adoption** (`unifyOwnAlbum`, and `ensureMirror`'s adopt branch),
  because that is the request carrying the album owner's credential — the same request that runs
  `grantAlbumWriters` and `grantInvitedHumans` (§4), which is what puts the bot on the album so it can
  comment at all. A line on an album a human owns cannot be written by a later loop.
- **Comments sync covers the human replies** on both albums (owner mapping pushes, member mapping
  pulls canonical) — the trail is what stays put, not the conversation.
- **A trail line needs a membership, and only the album's owner can grant one.** Posting to
  `POST /activities` requires album access, so the utility account writing the line must be a member
  of the album it writes on — verified: the household admin key answers `403 albumUser.create` on an
  album a different person owns, and a viewer cannot widen one either. On a REUNIFIED album the grant
  already happens at adoption, on the owner's forwarded credential (`grantAlbumWriters`, per §4), so
  the line rides that. On an album a human merely invited us into there is no such moment: the origin
  album's trail cannot be written by a background loop, and the design has to either take the line at
  the one request that carries the owner's credential or not write it on that side at all.
- Panel link in a comment is a **plain URL**: copy-pasteable, and Immich rendering it clickable is
  not something we control.

---

## 8. Comment `/commands` (album chatops) **[decided as a tool, not the happy path]**

A user-level control surface that reuses the already-synced comment channel — for the operations
with no native gesture, without needing admin rights.

### Governing UX principle

> A user who learns **zero** commands must have a fully working experience. Commands are progressive
> enhancement / recovery, **never** the happy path.

Order of preference for every interaction:

1. **Automatic** (e.g. dedup runs on merge, no input).
2. **Native gesture** (share menu = invite, leave = leave).
3. **Discoverable panel button** (a "Reunite these albums" button beats a memorised `/merge`).
4. **In-context prompted command** — a bot comment that says _"reply `un-dedupe` to see all"_ is
   discoverable **at the moment it's relevant**; the user reads what to type, never recalls it cold.
5. **Bare unprompted command** — only for power users who'd rather type it.

_A command you must memorise and issue cold is a design failure._

### Security model

- **Only act on comments authored by the server's own local users** — never on bot-materialised
  copies. This single rule gives, at once: cross-server dedup (only one server executes),
  spoof-resistance (materialised comments can't trigger), and natural authz (actor is a real,
  identified local member).
- **Command comments + bot responses are never synced** — filtered from the push (bot-authored
  comments are already excluded; the new bit is filtering human-authored command comments). This
  keeps chatter out of the shared conversation _and_ collapses the cross-server dedup concern
  entirely (a command never leaves its origin).
- **Strictly album-scoped, user-capability-bounded** — never server-level (no pair/unlink/config via
  comments). A comment is a weaker credential than a panel session → strictly smaller capability set.
- **No anonymous execution** (no share-link viewer can comment a command into running).
- **Bot responses tagged** so they don't re-trigger; executed-command ids tracked (extends the
  existing `seen_activity` ledger) so edits/re-syncs don't re-run.

### Architecture line this draws

**Comments are each user's _local_ control surface; the iroh peer protocol is the _cross-server_
transport.** So `/repair` executes locally, then initiates reunification over iroh; the other
household accepts via _their own_ local `/accept`. The comment channel never carries cross-server
coordination.

### Candidate command set

`/repair` (kick off reunification without the panel), `/accept`, `/dedup` → `/un-dedupe` / `/show`
(reveal suppressed dupes — non-destructive), `/status`, `/retry`, `/help`.

---

## 9. Related post-v1 items

- **Restore after a rebuild (the lost-`state.db` subset of reunification).** If `state.db` was
  backed up: mappings point at stale Immich ids → a re-anchor pass (re-resolve album by name,
  refresh ledger `originAsset` when a checksum matches but the id changed). _Note the current
  reconcile short-circuits on a known checksum, so it won't refresh a stale `originAsset` today —
  that's the additive change._ If `state.db` was lost: re-pair (works today, manual); seamless =
  additive **identity export/import** so a restore keeps the same key and skips re-pairing.
- **"Store shared assets locally" toggle.** Materialise full bytes instead of ~2KB hotlink stubs —
  real local replication. Additive (the byte path already fetches full originals); wants a
  per-mapping/config flag. Trade-offs: disk cost (defeats the ~2KB selling point when on), deepens
  co-owned-copy overlap. Upside: survives owner-offline permanently.
- **Save-to-library** (per-photo): explicit opt-in that stores a true original owned by the saving
  user — the deliberate way a copy lands on another disk.
- **Non-admin share-link redemption fix.** `getSharedLinkByKey` uses the admin key's per-user
  `/shared-links`, so a non-admin's share link can't be redeemed cross-server. Fix = switch to
  `/shared-links/me?key=` (also lets `sharedLink.read` be dropped from the key). **Not a clean
  drop-in:** `/shared-links/me` returns 401 for password links and never exposes the `password`
  field the addon currently compares — needs the `/shared-links/login` flow. Non-breaking; safe as
  v1.0.1. **Does NOT affect IPP** (IPP uses `publicShareLinkMeta`, already `/shared-links/me`, and
  the interceptor's `?key=` forwarding — neither touches `getSharedLinkByKey` or `sharedLink.read`).

---

## 10. Rejected alternatives (kept so they aren't re-proposed)

- **Auto-merge / "always repair" without confirmation.** Dropped — false matches on generic album
  names would auto-merge unrelated albums. Always owner-to-owner request→accept instead (§6).
- **Hash tokens / HMAC / PSI / masked album names for matching.** Security theater between trusted,
  deliberately-paired, opted-in servers — you're already streaming full photos/comments; the album
  _name_ is trivially less sensitive, and low-entropy names are brute-forceable by the peer anyway.
  The opt-in (default-on-with-disclosure) is the real control. Match on **plaintext** names past
  consent; normalise for _recall_, not privacy. _(Normalisation stays; the obfuscation is struck.)_
- **Native Immich dedup as the cross-server matcher.** Can't work: our stubs are generic ~2KB
  placeholder JPEGs with none of the real photo's visual content, so CLIP can't pair stub↔real (and
  would junk-pair stub↔stub); the pair is also cross-owner (bot vs user), and there's no API to
  query Immich's ML with an external ref. Native dedup keeps its proper narrow lane: a user's **own**
  real-vs-real dupes (same owner, real content) — left entirely to Immich, complementary not a
  substitute.
- **Destructive dedup.** Replaced by non-destructive suppression (§3) — no reason to delete when
  hiding is reversible and loses nothing.
- **Pair-private audit trail.** Made public (§7) — Immich has no per-user-private comment, and an
  album's history is legitimately shared context anyway.
- **Opt-in (default-off) album recovery.** Flipped to default-on-with-disclosure (§6) — wanted
  feature, low-sensitivity data, and opt-in's silent-absence failure mode is worse.

---

## 11. Open questions

- **Proactive vs request-driven matching UX.** With default-on consent, proactive ("here are your
  matches") is defensible and friendlier; request-driven is more minimal. Consent makes proactive
  fine — pick per build.
- **Per-user vs admin granularity.** Admin-level toggles fit the family case; per-user opt-ins /
  "always repair mine" could layer on later if a multi-user server needs it (additive).
- **Immich comment link rendering** — whether panel URLs render clickable in Immich's comment UI, or
  are copy-paste only (minor).
