# State store

`store.ts` — SQLite-backed persistence, on `node:sqlite`, which is built into Node and so keeps the
zero-dependency promise.

## Two shapes, for two access patterns

**Hot ledgers as indexed tables.** `seen` and `seen_activity` are read once per photo per cycle;
as arrays those lookups were O(n) scans and every append rewrote the whole state file. As indexed
tables they are `SELECT`s, and appends are appends.

**Small collections as one kv row each.** `keys`, `peers`, `mappings` and `contributors` stay an
in-memory object persisted in a single transaction — the same ergonomics as the old JSON file, now
crash-safe via WAL.

`kv()`/`kvSet()` exist for small side-tables that do not deserve a typed field on `state`
(currently just unredeemed pairing codes). Deliberately narrow: the four collections above have
their own fields and their own save path, and this must not become a second way to write them.

## The `added` table is a security record

`added (al, us)` holds the album memberships **this sidecar created**, as opposed to ones a human
made. It is what lets invitation detection tell "a human invited them" from "we put them there for
attribution", and getting it wrong in the unsafe direction shares an album nobody offered.

**The write order is the property, not the table.** Callers record *before* the membership exists:

- crash between record and add → a row with no membership → we *ignore* a real invitation, which is
  visible and the human simply re-adds
- record *after* the add → a membership with no row → reads as human intent → the album is shared
  with a server nobody offered it to

Always fail towards under-sharing. `addedForget` keeps the table self-healing: once a membership is
gone the row goes, so an album we once added someone to can still be shared with them by hand
later.

## Types that say what the query guarantees

`ledgerWithOrigin` filters `o IS NOT NULL` in SQL, so its return type says `o: string` rather than
leaving every caller to re-check what the query already promised. That pattern is worth copying —
under `strictNullChecks` a vague return type multiplies into a null check at every call site.

## No migration from the old JSON state

The `state.json` → `state.db` importer was removed at v1.0.0. No released version wrote that file,
so it protected nobody, and a legacy bridge here would have been permanent maintenance. See
[`config.md`](./config.md) for the scope of that one-time allowance — it expired with v1.
