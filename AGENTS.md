# Working on this repo (humans and AI agents)

This is the contract for changing immich-shared-albums. It applies to everyone, and
especially to AI coding agents — read it before you make changes.

## The ethos this inherits

Immich exists so people own their photos and host them themselves. Cross-server sharing is the
easiest place to quietly betray that, so this addon inherits the constraint rather than treating
it as Immich's problem. Concretely, and these are design rules not sentiments:

- **Originals never leave the owner's server.** A shared photo materialises elsewhere as a stub
  whose bytes stream from its owner on demand. Nobody accumulates copies of anyone else's
  library, and the owner can stop serving at any moment.
- **No third party, ever.** Two servers talk directly, signed with their own ed25519 keys. There
  is no broker, no account with us, nothing to shut down.
- **Sharing is per person, and the person is their own server's account.** Not a "household", not
  an identity this addon invents. Accounts here are keyed by the person's id on *their* server.
- **Anything shared can be fully withdrawn, and withdrawal reclaims the space.** `leaveAlbum`
  purges every stub a join created; unlinking deletes a peer's people *and their proxied photos*,
  because holding someone's content after they have gone is exactly the thing this opposes.
- **Every sharing ACTION happens in Immich's own UI** (see the product rule below). The addon adds
  no second way to share, so nobody has to learn our surface to use their own photos.
- **Minimise the footprint in someone else's instance.** Every user, album, and permission this
  addon creates is a liability the operator did not ask for.

**Where we currently fall short, honestly:** the sidecar still needs an all-permissions admin API
key, so its blast radius is the whole instance — the sharpest contradiction of this ethos in the
codebase, and worth chipping at whenever a change touches key handling. It also creates real user
accounts in your Immich (one per remote person) that show up in every picker, because Immich has
no service-account flag. Both are known costs, not oversights; do not make either worse without
saying so.

## Golden rules

- **Never touch Immich itself.** This is a sidecar: it only ever adds its own container
  and talks to Immich over the public API. Never modify Immich's source, compose
  services, database, or upload folders. Everything must fail open — Immich has to work
  perfectly with the sidecar dead. (Design invariants: [src/ARCHITECTURE.md](./src/ARCHITECTURE.md) "Iron rules".)
- **Keep the docs in sync — and this rule is load-bearing, not housekeeping.** `src/` carries
  Markdown docs at whatever level earns one: a folder doc where modules are small and cohesive, a
  file-level doc next to anything with dense reasoning of its own, and neither where a file needs
  no explaining. `src/ARCHITECTURE.md` describes the whole.

  Any behaviour change updates the relevant doc(s) **in the same change**. A doc that lies is
  worse than no doc: treat drift as a bug and fix it with the code that caused it.

  Explanation lives in these docs rather than in comments — naming carries the *what*, docs carry the *why* (see the naming section below). That
  only works while they track the code, so the further an explanation sits from what it explains,
  the more strictly this rule applies. Moving prose out of a source file and then letting it rot
  is worse than having left it inline.

  Four rules for writing them:

  - **Dense over flowing.** Bullets, tables and short declaratives — not paragraphs of prose. A
    doc is reference material read under time pressure, usually to answer one question. Maximise
    facts per line.
  - **Every claim must be checkable, and checked.** Name the real symbol, the real route, the
    real env var. Prose that paraphrases behaviour cannot be verified and rots invisibly; a doc
    saying `handleVersion` answers `…/version` can be grepped in a second.
  - **State what the code does, not what it should do.** Re-read the doc against the
    implementation before you land it. A doc written from a plan describes the design you may
    have since rejected, and reads as authoritative while doing it.
  - **Boy-scout, never batch** — see the section below. Verify a doc when you touch the code it
    describes; do not mass-rewrite docs you are not otherwise changing.
- **Never test against a real server.** Use the throwaway mock rig in `demo/`. Never run
  the suite or experiments against anyone's production Immich, and never modify a real
  user's library.
- **No secrets in the repo.** No API keys, passwords, tokens, or personal data in commits,
  logs, or committed files. Ever.

## How changes land

- **Everything goes through a pull request**, gated on both e2e lanes and the fast gate below. Branch protection enforces it; merges are squash-only.
- **Conventional commits** decide the version automatically via release-please
  (`fix:` → patch, `feat:` → minor, `feat!:` → major). Don't hand-edit version numbers.
- **Before pushing:** `npm run verify` clean (format, lint, types, runtime load, import cycles,
  unit tests — seconds), then BOTH e2e lanes:

  ```
  bash demo/run-mock-e2e.sh                       # API suite
  cd demo/e2e && CKEY=<origin key> \
    HOST_RESOLVER_RULES="MAP host.docker.internal 127.0.0.1" node browser-test.mjs
  ```

  **Run the browser lane whenever you touch a page.** It is the only coverage of the banner and
  accept flows — nothing in the API suite loads a page in a browser, so a page can break with that
  suite fully green. The resolver rule exists so this runs on a dev machine without editing
  /etc/hosts.

  Run against a FRESHLY PURGED rig. `run-mock-e2e.sh` purges; recreating containers by hand does
  not, and stale bot keys in `state.db` produce `Invalid API key` failures that look like product
  bugs and are not.
- **Enable the hook once per clone:** `git config core.hooksPath .githooks`. It runs the fast
  gate on commit. The e2e suite is deliberately NOT in the hook — a seven-minute hook is a hook
  people bypass.
- **Formatting is Prettier's, correctness is ESLint's.** They do not overlap: `eslint.config.mjs`
  contains zero formatting rules, and that is a property to preserve. Never add
  `tseslint.configs.stylistic`/`recommended` or a whitespace rule there.

## Write the test first

Two lanes, and the right one depends on whether Immich is involved.

- **Pure logic → strict TDD.** Add the case to `src/*.test.ts`, watch it fail, then implement.
  The loop is sub-second (`npm test`), so there is no excuse to skip it. Anything that can be a
  pure function should be one, precisely so it can be tested this way — see `sync/invitees.ts`,
  which was extracted from the one code path that removes a real person from a real album.
- **Immich-facing behaviour → discover, then pin, then implement.** You cannot write a correct
  test against an API whose behaviour you are guessing at, and guessing has caused real bugs
  here: `GET /albums` is scoped per user, adding a user who is already the owner returns 200 and
  is silently ignored, and album responses carry no `ownerId`. So probe the real thing on the
  mock rig first, write the e2e assertion, then implement. The test still precedes the
  implementation — it just follows the discovery.

**Assert invariants, not strings.** "No two users share a display name" survives every future
rename; a test pinning one literal name has to be edited whenever behaviour changes, and a test
edited to match new behaviour has stopped being a test. **Print real state on failure** — a
message showing what was actually found saves a whole debugging cycle, and the e2e suite's
`check(name, ok, detail)` takes that detail for exactly this reason.

## Store the fact, don't infer it — but only if the fact is safe to hold

Nearly every sync bug in this project came from *deducing* something the code could have
recorded. Two accounts existed for one person so that "who added this album membership" could be
inferred from which account it was; a boolean said "we know where this person lives" instead of
storing *where*; a mapping pointed at an account by a name-derived slug instead of its id, and
stopped resolving the moment the account was keyed differently. Each inference was correct when
written and wrong later.

So prefer a column in `state.db` over a rule in someone's head. **With two constraints, because
a stored fact is also a stored liability:**

- **Only store what is safe to hold.** `state.db` holds this household's ed25519 private key and
  the bot accounts' API keys, so anything added inherits that blast radius. (The *admin* key is
  not in there — it comes from `IMMICH_API_KEY` in the environment.) Two rules follow, neither
  about compliance:
  - The bot password is rolled to a value nobody keeps (`ensureLocalAccountFor`), because it existed
    only to mint one API key and has no purpose afterwards. The concrete gain is small but real:
    a bot key deliberately lacks `apiKey.create`, so it can do its 22 things and no more, whereas
    a password logs in interactively and can mint an unrestricted key for that account. Keeping it
    is pure downside rather than a tradeoff — the bots are non-admin and quota-capped, so this is
    cheap hygiene, not a critical control. The e2e asserts it.
  - The user directory sends **names, not emails** — not because storing an email is dangerous,
    but because an Immich email is a *login identifier*. Sending it gives a linked household, or
    whoever later compromises it, the first half of a credential for every user here. Names are
    all a picker needs, so nothing is given up.

  Both scale with exposure: on a single-user LAN-only box they buy little, and on a public domain
  with several linked households they matter. Default to the cautious side when it is free, and
  say which it is rather than implying everything is critical.
- **Order the writes so a crash fails safe.** A stored fact that is missing must lead somewhere
  harmless. `added` records a membership BEFORE creating it, so a crash in between makes the
  sidecar *ignore* an invitation rather than treat its own membership as a human's and share an
  album nobody offered. Work out which way each new record fails before writing it, and say so in
  a comment.

Corollary: a fact only counts as known if something *proved* it. `Contributor.homePeer` is set
only by a linked server's directory, never by an incoming photo — a relayed ref names the person
but not their server, and guessing would route someone's album to the wrong household.

## Every source file opens with one line: what it is, and where its doc is

A single line, first line, no exceptions:

```ts
/** sync/invites.ts — sharing an album by inviting a PERSON in Immich's own picker. See sync-loops.md. */
/** sync/leave.ts — undoing a join. See sync-loops.md. */
```

Format: `path — brief description. See <doc>.md.`

This is the one comment whose job cannot be done by naming, because it answers a question the code
cannot: **where is the context for this file?** Some files have a doc of their own beside them
(a `config.md` beside `config.ts`, once one earns it); others are covered by a folder doc under a
different name
(`p2p/protocol.ts` → `wire-protocol.md`). Without the pointer you would have to guess or grep.

It also makes the link machine-followable, which matters because agents work here: open the file,
read one line, know exactly which doc to load for context before changing anything.

Two rules keep it honest:

- **Keep the pointer accurate.** A header pointing at a doc that no longer exists, or at the wrong
  one, is worse than none — it sends the next reader somewhere useless. Renaming or moving a doc
  means updating every header that references it.
- **Do not let it grow.** It is a pointer, not a summary. If you find yourself adding a second
  sentence, that sentence belongs in the doc.

## Boy-scout rule: any file you touch comes up to standard

**A file you edit for any reason leaves your change compliant.** The conventions below are applied
per-change, not by sweeping the tree, so the codebase converges as work moves through it.

Six checks, all of them seconds:

| Check | Standard | Where it is written |
| --- | --- | --- |
| Header | line 1 is `path — description. See doc.md.`, and a whole sentence | *Every source file opens with one line* |
| Comments | the header, load-bearing lines and TODOs — nothing else | *Comments: a paired doc is the default* |
| Names | **rename rather than explain** — any name you must explain is not descriptive enough | *A name that needs a comment* |
| Doc placement | one exists at the right level for what you touched | *Where a doc lives* |
| Doc truth | you re-read it against the code you just changed | *Keep the docs in sync* |
| Doc style | dense bullets, every claim naming a real symbol | *Keep the docs in sync* |

Two things this rule is deliberately **not**:

- **Not a licence to batch-migrate.** Do not sweep files you are not otherwise changing. The
  verification is the expensive half, and it is only cheap while you have the code in your head.
- **Not a blocker on unrelated work.** If a file you touched is far off standard and fixing it
  would swamp the actual change, bring the part you touched up to standard and say what you left.

**Removing a comment is a move, never a delete.** Its content goes to one of two places, and
choosing is the whole job:

- **Into the name**, when it explained *what* something is. Three that are waiting in this tree,
  as worked examples: `mayAdd` carries a comment about revoked members — it should be
  `reAddIfMissing`, and the comment goes with the rename. `WATCH_RUNNING` carries one about
  stampeding the host — it should be `watchCycleInFlight`. `(cacheMaxMb * 1024 * 1024) / 10`
  carries one about the per-item cap — the divisor should be a named constant. Renaming a
  parameter, extracting a named constant and splitting a condition into a named boolean are all in
  scope of the change that deleted the comment; do not stop at deletion and leave the name as it
  was.
- **Into the doc**, when it explained *why* — design reasoning, an Immich quirk, history.

If neither fits and the line is a hazard at its trigger point, it stays inline as one line.

All six are judgement calls, which is why they are written down rather than left implied.

## Where a doc lives: as close to the code as it needs to be, and no closer

Granular on purpose. Pick the nearest level that earns one:

- **File-level** — one module carrying dense reasoning of its own, e.g. a `store.md` next to
  `store.ts`. None exist yet; create one the first time a module earns it.
- **Folder-level** (`wire-protocol.md`, `sync-loops.md`) — a concern spanning several files, where
  the useful explanation is how they fit together.
- **Neither** — most files. A module whose names already say what it does needs no doc; it still
  carries a header pointing at whichever doc covers it.
- **Both** is fine. A file-level doc for the hard module, a folder doc for the concern around it.

A concern starts as one file at `src/` root, and graduates to a folder with its own doc when it
needs several files. `src/ARCHITECTURE.md` describes the whole tree.

## Comments: a paired doc is the default, inline is the exception

**The target state for any file: the one-line header, plus load-bearing lines and TODOs. Nothing
else.** If a file you are working in carries more than a couple of comments, the explanation
belongs in its doc and the rest belongs in better names.

Explanation belongs in a Markdown doc beside the code, not in the code. Naming carries the *what*;
the doc carries the *why*. Code that reads cleanly and a doc that explains fully beats a file where
both are tangled — and a doc can hold far more context than anyone would tolerate inline.

**The test for keeping a comment inline: would moving it to the doc stop it doing its job?**

Almost always the answer is no, so it moves. Two cases where it is yes, and they are the only ones:

- **A hazard at the trigger line.** `record BEFORE the add`, `splice, never reassign`,
  `ORDER IS LOAD-BEARING`. The person editing that exact statement must see the warning without
  knowing a doc exists. One line, and it may point at the doc for the reasoning.
- **A test case's rationale.** *"the doubled form a relay hop produces, which is what this exists
  to prevent"* — that sentence IS the case's meaning. Without it the assertion is a bare comparison
  that a later reader deletes as redundant, or "fixes" to match new behaviour. The reader who needs
  it is looking at the assertion, so it cannot live anywhere else.

- **A one-line JSDoc on an exported type field or function.** Editors surface it on hover at every
  use site, which no doc can do. `/** Mutable hint — where to reach them right now. */` on
  `Household.url` earns its place; a paragraph above the type does not.

Everything else goes: background, design reasoning, Immich quirks, "why this shape", history. The
reader who needs those is trying to understand the module and will be reading its doc. Inline, they
are noise standing between someone and the code.

Corollary, and the reason this is worth the effort: comments rot **silently**. Prose in a doc gets
reviewed as prose; prose wedged between statements gets skipped, and goes on asserting things that
stopped being true several changes ago.

### What survives, concretely

Every comment that stays must fall into one of these categories. If the one you are about to keep
fits none of them, it belongs in the doc:

| Category | Example |
| --- | --- |
| Deliberate-swallow marker on an empty `catch` | `/* already gone */`, `/* fail-open */` |
| Ordering or aliasing hazard at the line | `record BEFORE the add`, `Splice, NEVER reassign` |
| A revocation rule (fails towards under-sharing) | `missing member on an invitation album = REVOKED` |
| A test contract other tooling depends on | `#who/#go/#out are a TEST CONTRACT` |
| A wire route a type name cannot hold | `POST …/albums/:mappingId/refs` |
| An external contract we do not get to name | the Immich API's response shape, a CGNAT regex |
| A tooling marker | `// x-release-please-version` |

A bare `catch {}` reads as a forgotten branch, so three words saying the swallow is intended is
load-bearing — that is why the first row exists and why it is the largest group.

Two traps when doing this work. **Judge each comment; never keyword-match it** — a block containing
`ONLY` or `NEVER` is not automatically a hazard, and design prose hides behind those words. And
**a mechanical strip truncates**: it leaves fragments that end mid-clause but still read like
instructions. Re-read every comment you touch, in full.

## A name that needs a comment is the wrong name

This is the default, and it comes before every other rule about comments: **if you have to explain
a name, the name is not descriptive enough. Rename it.** The comment is a symptom; fix the cause.

It applies to everything you get to name — functions, variables, constants, parameters, type
fields, files, routes, env vars, test titles, doc headings. Nothing is exempt for being small or
local.

The test is whether a reader who has never seen the code guesses right from the name alone:

- `/** How often to re-check whether they have signed in. */` above `POLL` → `SIGN_IN_POLL_MS`.
- `/** The server this person actually lives on. */` above `peer` → `homePeer`.
- `(CFG.cacheMaxMb * 1024 * 1024) / 10` with `// no single item >10% of cap` →
  `/ MAX_ITEM_SHARE_OF_CACHE`.
- `mayAdd`, with a comment about revoked members — **still wrong**, which is the point: it says
  permission where the real meaning is "if they are missing, put them back". Renamed to
  `reAddIfMissing`, and its two comments went with it. Getting one rename in and still needing the
  comment means go again, not settle.

Reach for a longer name before reaching for a comment. `startPollingUntilSignedIn` needs no
explanation; `tick` needs a paragraph. A name is read every time it is used; a comment is read
once, if at all, and then rots.

What survives this rule is only what a name **cannot** carry:

- a hazard about ORDER or CONCURRENCY at the exact line it applies to
- a reference to an external behaviour that is not in this codebase — an Immich quirk, a browser
  constraint — and even then prefer the paired doc unless the reader of that line needs it
- a `TODO` with enough context to act on

If you find yourself writing "this is needed because…", that is doc material, not a comment. If you
find yourself writing "this does X", the name should have said X.

## Name things so the next reader does not have to decode them

Not style policing — bad names hide bugs. A `useEffect` in the accept page used `tick`, `u`, `iv`
and `stop`, and buried in that soup was a `return () => clearInterval(iv)` inside a `.then()`,
which is dead code: Preact only honours the value the effect itself returns, so the poll kept
running after the page navigated away. With the pieces named for what they hold, the missing
cleanup was obvious on sight.

- **Name a variable for what it holds, not its type or its position.** `signedInUser`, not `u`.
  `pollTimer`, not `iv`. `outcome`, not `d`. `minutesLeft`, not `minutes`.
- **Name a function for what it does to the world**, and make the verb match: `acceptInvite`,
  `startPollingUntilSignedIn`, `copyToClipboard` — not `accept`, `tick`, `copy`.
- **Single letters only for a genuinely anonymous, one-line scope** — `xs.map(x => x.id)`. Never
  for anything that lives more than a couple of lines, and never for a caught error you go on to
  inspect.
- **Magic numbers get a named constant with a unit**: `SIGN_IN_POLL_MS`, `SYNC_WAIT_LIMIT_MS`.
  `2500` in the middle of an effect tells the reader nothing about whether it is safe to change.
- **Extract the condition rather than commenting it.** `const waitedTooLong = Date.now() - since >
  LIMIT_MS` reads better than the inequality inline, and it puts the reasoning in the name.
- **Comments say WHY, names say WHAT.** If a comment is needed to explain what a line does, the
  names are wrong. Reserve comments for the reason: which Immich quirk forced this, which failure
  it protects against, which direction it fails in.

This applies to test code too. An assertion whose message does not say what broke costs a
debugging cycle every time it fires.

## Invariants that will bite you

These are enforced by lint or tests where possible, because each one has already caused a bug.

- **Bot users live in disjoint namespaces** (`BOT_PREFIX` in `config.ts`). Invitation detection
  reads "this bot is an album member" as a human's intent to share, which is only sound for bots
  the sidecar *never* adds itself. Attribution contributors are the opposite — the sidecar adds
  those. One user once served both roles, and origin and member ping-ponged mirror/withdraw every
  poll, each offering the other a mirror of the other's album.
- **Never reassign shared state arrays.** `state.mappings = state.mappings.filter(...)` discards
  whatever a concurrent loop pushed onto the old reference. Splice in place. (ESLint enforces it.)
- **Never inline a single-source-of-truth constant** — the bot email domain, `PROTOCOL_VERSION`.
  The last naming bug was one predicate inlined in eleven places that drifted apart. (ESLint
  enforces both.)
- **Owner and member mappings are not interchangeable.** Origin-side logic must filter
  `role === 'owner'`; a member's mirror always looks "withdrawn" to origin-side checks, and
  retiring it kills a live album one poll after it was created.
- **Route before reading a body** in `web/server.ts`, and mark deliberate fire-and-forget with
  `void` so it is distinguishable from a forgotten `await`.

## Layout

Code is grouped by concern under `src/` (a `config`/`state`/`peers` core, then `immich/`,
`p2p/`, `sync/`, `media/`, `web/`). See [src/ARCHITECTURE.md](./src/ARCHITECTURE.md) for the
module map, the data flow, and the doc conventions.
