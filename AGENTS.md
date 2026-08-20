# Working on this repo (humans and AI agents)

This is the contract for changing immich-shared-albums. It applies to everyone, and
especially to AI coding agents — read it before you make changes.

## Golden rules

- **Never touch Immich itself.** This is a sidecar: it only ever adds its own container
  and talks to Immich over the public API. Never modify Immich's source, compose
  services, database, or upload folders. Everything must fail open — Immich has to work
  perfectly with the sidecar dead. (Design invariants: [src/ARCHITECTURE.md](./src/ARCHITECTURE.md) "Iron rules".)
- **Keep the docs in sync.** Every folder under `src/` has a Markdown doc describing it,
  and `src/ARCHITECTURE.md` describes the whole. Any behaviour change updates the relevant
  doc(s) in the same change. A doc that lies is worse than no doc: treat drift as a bug and
  fix it with the code that caused it.
- **Never test against a real server.** Use the throwaway mock rig in `demo/`. Never run
  the suite or experiments against anyone's production Immich, and never modify a real
  user's library.
- **No secrets in the repo.** No API keys, passwords, tokens, or personal data in commits,
  logs, or committed files. Ever.

## How changes land

- **Everything goes through a pull request**, gated on the e2e suite (123 checks + a browser
  lane) and the fast gate below. Branch protection enforces it; merges are squash-only.
- **Conventional commits** decide the version automatically via release-please
  (`fix:` → patch, `feat:` → minor, `feat!:` → major). Don't hand-edit version numbers.
- **Before pushing:** `npm run verify` clean (format, lint, types, import cycles, unit tests —
  seconds), then the e2e suite green (`bash demo/run-mock-e2e.sh` — minutes). CI runs the fast
  gate first so a formatting slip fails in seconds rather than after booting four Immich stacks.
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
