# Post-v1 design spec: Google shared-album reunification & the user-level surface

> Status: **design, not built.** Everything here is post-v1 and confirmed **non-breaking** — it
> rides surfaces and identities that v1 already ships and freezes. Captured from the 2026-08-25
> design discussion. Decisions are marked **[decided]**; open choices **[open]**; things
> considered and dropped are in "Rejected alternatives" with rationale.

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
migrates independently via **Google Takeout + immich-go** and lands with a *partial* album of the
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
contributions as real photos, and holds the other's as hotlink stubs.** So the sync *primitives*
(contribute-push, materialise, manifest, reconcile) already exist. The novel orchestration is:

1. **Match** the two partial albums (name + metadata + creation date + **owner** — see §4).
2. **Adopt** each side's *existing populated* album as the mapping — rather than the normal "join
   creates a fresh empty mirror" — so nobody ends up with two copies of the album.
3. **Bidirectional initial contribute** with non-destructive dedup (§3).

### Honest ceiling
"Exact original Google state" is **best-effort**. Google Takeout re-encodes/strips EXIF per export,
so the *same* shared photo exported by both people can arrive with **different bytes → different
checksums**. Reunification converges to "very close, deduped where content or metadata agree," not
guaranteed pixel-identical where Google diverged the copies.

---

## 3. Dedup: non-destructive suppression **[decided]**

The key design decision that de-risks the whole feature: **dedup is never destructive.**

For a photo **both** servers own, don't delete and don't hotlink — **each side represents it with
its own local real asset and suppresses the incoming ref** (never materialise a stub for it).

- **Symmetric & coordination-free:** Alice uses Alice's copy, Bob uses Bob's, independently.
- **Self-sufficient:** no online-dependency on the peer for photos you already hold.
- **Reversible:** un-suppress = reveal/materialise the incoming stub so both show ("un-dedupe").

### Why this is the unlock
With *destructive* dedup, a false-positive match loses a photo, so matching would have to be near-
perfect (impossible across mangled Takeout exports). With **non-destructive suppression, both error
directions are cheap and reversible:**

- A **miss** → a redundant hotlink stub of a photo you already own. Harmless.
- A **false positive** → one photo temporarily hidden, undoable. No loss.

So cross-server match precision becomes a **soft optimisation, not a correctness requirement.**

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
my-photo-vs-shared-with-me. A restored server can hold *real copies* of photos it only held as
stubs, and every restored server looks like an owner of everything (bots/stubs never export).

### Resolution
- For **reunification**, ambiguity is resolved by **consent** — it's an owner-to-owner
  request→accept (§6), so nothing is guessed.
- For the **lost-`state.db` restore subset** (§9): ownership survives as long as **one** side kept
  its record; on re-pair, whichever still holds `role: 'owner'` re-asserts it. Only if **both**
  lost it is ownership truly gone → a human "who owns this?" decision. Never machine-guessed.

### The album owner must travel in the match metadata
Match metadata is **name + date + metadata + OWNER**. The owner field is required because:

1. **It scopes the match to a user, not the server** — the match shows only in *that owner's* user
   panel, not server-wide or to the admin.
2. **It routes the request owner-to-owner** (Alice's "Summer 2024" owner → Bob's owner).

Owner-sharing **rides the existing directory exchange** (linked servers already share user
identities), so it's no new identity disclosure — but album matching therefore **depends on the
directory being shared** (directory off → owner can't travel → can't match/route).

---

## 5. The four-surface model **[decided]**

Each surface has exactly one job:

| Surface | Job |
|---|---|
| **Admin panel** | *Server-owned* config: pair/unlink, server settings, API key, the "allow shared album recovery" toggle. |
| **User panel** *(new — the keystone)* | *My* stuff: albums shared with/by me, the **matches list**, the **repair** button, **pending repair requests**, per-user settings (incl. per-user directory opt-in). |
| **Native gestures** | Share menu = invite, leave album = leave (existing model, unchanged). |
| **Comments** | The in-context/recovery escape hatch: discovery nudges, the public audit trail, and `/commands`. |

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
- The **link-time popup is informational**, not a gate: *"Album recovery is on: linked servers can
  see album names to find shared albums to reunite. Turn off in settings if you'd rather not."* The
  popup **writes** the durable toggle; the panel keeps the switch.
- **Reciprocal:** each admin's link flow shows it; each consents for their side; if either declines,
  matching is off/one-directional.
- **Caveat (write down, don't act on):** this rests on *trusted family servers*. If the audience
  ever broadens to less-trusted peers, revisit the default.

### The flow **[decided: no auto-merge]**
Albums **never auto-merge.** The flow is always:

1. Matching runs (both sides opted in) and finds candidates.
2. Each candidate surfaces in the **owner's** user panel (scoped by the owner field, §4), and a
   **local bot-comment nudge** is posted (§7).
3. The album owner **sends a repair request** to the matching album's owner on the other server.
4. That owner **accepts in their own panel**.
5. The merge runs with non-destructive dedup (§3); a **public audit trail** is posted (§7).

### Why no auto-merge
An unconfirmed auto-merge is where a **false match** bites (generic names like "Photos"/"2024"
colliding). Keeping owner-to-owner confirmation is exactly where a human catches "those aren't the
same album." Non-destructive + audit trail make even a bad merge reversible, but confirmation is
cheap insurance. *(This supersedes an earlier "always repair / auto-reunite" idea — dropped.)*

---

## 7. Notifications & the audit trail **[decided]**

**Don't build notification infrastructure — lean on Immich's native activity** (iron rule 8).
Consistent pattern throughout: **bot comment = the discovery/notification nudge; user panel = the
actionable content.**

### Match-found nudge
When a match is found, post a **local bot comment** on the owner's album: *"We found a possible
match to reunite this album — view in your panel [link]."*

- *"Only the local user sees it"* resolves naturally: it's posted on the owner's **own pre-repair
  album**, which for a Takeout import is typically **owner-only**, so it's private by album
  membership — no per-user-comment trick needed.
- Edge case: if the album already has local co-members, they'd see the nudge too — harmless, since
  the comment only says "see your panel" and the match list is behind the auth-scoped panel.
- Bot-authored → already excluded from sync → stays local. Panel link is a URL in the comment
  (copy-pasteable even if Immich doesn't render it clickable).

### Audit trail — **public** in comments
Revised from "pair-private" to **public**: an album's history is legitimate shared context for
everyone in it, like an edit history; members see contents change anyway, so hiding *why* is the odd
choice. This also removes the wrinkle that **Immich has no native per-user-private comment.**

- **Comments** hold the full public trail + discoverable prompts: *"Repair requested by X,"
  "accepted by Y," "Repair successful — 3 photos merged by non-destructive dedupe, reply `un-dedupe`
  to see all."*
- **User panel** holds the actionable bits (pending requests, repair button, settings) and can keep
  a private per-user history if wanted.
- Impl: bot-authored audit comments are sync-excluded, so **each side posts the trail locally** as
  the coordinated request/accept events complete (both servers know both events via the peer
  protocol) — all members on both servers see the same history without syncing comments.

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
4. **In-context prompted command** — a bot comment that says *"reply `un-dedupe` to see all"* is
   discoverable **at the moment it's relevant**; the user reads what to type, never recalls it cold.
5. **Bare unprompted command** — only for power users who'd rather type it.

*A command you must memorise and issue cold is a design failure.*

### Security model
- **Only act on comments authored by the server's own local users** — never on bot-materialised
  copies. This single rule gives, at once: cross-server dedup (only one server executes),
  spoof-resistance (materialised comments can't trigger), and natural authz (actor is a real,
  identified local member).
- **Command comments + bot responses are never synced** — filtered from the push (bot-authored
  comments are already excluded; the new bit is filtering human-authored command comments). This
  keeps chatter out of the shared conversation *and* collapses the cross-server dedup concern
  entirely (a command never leaves its origin).
- **Strictly album-scoped, user-capability-bounded** — never server-level (no pair/unlink/config via
  comments). A comment is a weaker credential than a panel session → strictly smaller capability set.
- **No anonymous execution** (no share-link viewer can comment a command into running).
- **Bot responses tagged** so they don't re-trigger; executed-command ids tracked (extends the
  existing `seen_activity` ledger) so edits/re-syncs don't re-run.

### Architecture line this draws
**Comments are each user's *local* control surface; the iroh peer protocol is the *cross-server*
transport.** So `/repair` executes locally, then initiates reunification over iroh; the other
household accepts via *their own* local `/accept`. The comment channel never carries cross-server
coordination.

### Candidate command set
`/repair` (kick off reunification without the panel), `/accept`, `/dedup` → `/un-dedupe` / `/show`
(reveal suppressed dupes — non-destructive), `/status`, `/retry`, `/help`.

---

## 9. Related post-v1 items

- **Restore after a rebuild (the lost-`state.db` subset of reunification).** If `state.db` was
  backed up: mappings point at stale Immich ids → a re-anchor pass (re-resolve album by name,
  refresh ledger `originAsset` when a checksum matches but the id changed). *Note the current
  reconcile short-circuits on a known checksum, so it won't refresh a stale `originAsset` today —
  that's the additive change.* If `state.db` was lost: re-pair (works today, manual); seamless =
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
  *name* is trivially less sensitive, and low-entropy names are brute-forceable by the peer anyway.
  The opt-in (default-on-with-disclosure) is the real control. Match on **plaintext** names past
  consent; normalise for *recall*, not privacy. *(Normalisation stays; the obfuscation is struck.)*
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
