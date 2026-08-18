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

- **Everything goes through a pull request**, gated on the e2e suite (66 checks + a browser
  lane). Branch protection enforces it; merges are squash-only.
- **Conventional commits** decide the version automatically via release-please
  (`fix:` → patch, `feat:` → minor, `feat!:` → major). Don't hand-edit version numbers.
- **Before pushing:** `npx tsc --noEmit` clean, and the suite green
  (`bash demo/run-mock-e2e.sh`). CI runs both; run them locally first when you can.

## Layout

Code is grouped by concern under `src/` (a `config`/`state`/`peers` core, then `immich/`,
`p2p/`, `sync/`, `media/`, `web/`). See [src/ARCHITECTURE.md](./src/ARCHITECTURE.md) for the
module map, the data flow, and the doc conventions.
