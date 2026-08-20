# Configuration and the names this addon claims

`config.ts` holds process configuration, the logger, and the small set of strings that decide what
this addon calls things inside someone else's Immich. The names matter more than they look: several
are load-bearing, and getting one wrong has caused real bugs.

Env vars themselves are documented for operators in the README's configuration table. This file is
about the constants that are *not* configurable, and why.

## `ROUTE_PREFIX` — `/immich-shared-albums`

"sidecar" was a generic term staking a claim another Immich addon could reasonably want, so it
moved to a name specific to this project. There is deliberately **no compatibility shim** for the
old prefix: the install base was small enough that a clean break beat carrying a second route
surface forever. Both peers must run a version that agrees on this.

## `UTILITY_EMAIL_DOMAIN` — `@immich-shared-albums.local`

The email domain for the accounts this addon creates. Named after the project for the same reason
`ROUTE_PREFIX` is, and these addresses are how we tell our own accounts apart from real people.

A clean break from the old `@sidecar.local`: no rename migration, no dual-domain acceptance. That
was a **one-time v1.0.0 allowance**, taken because the install base was ~zero and a legacy bridge
here would be permanent maintenance. It is *not* the policy afterwards — past v1, changes to this
domain need a migration path.

Getting the `isUtilityEmail` check wrong is not cosmetic: an account misread as a human gets added
to mirrors as a member and its stubs counted as someone's photos. The single-domain test stays the
kind of thing that is obviously correct by inspection.

## `BOT_PREFIX` — one account per remote person

There is **one** local account per remote person, doing both jobs: it owns their mirrored photos,
and it is what a human picks in Immich's album picker to share with them.

They used to be two accounts, because invitation detection reads "this account is an album member"
as human intent, and the sidecar adds accounts to albums itself for attribution. Immich forces that
overlap — an album owner adding an asset owned by a **non-member** is refused with
`no_permission` — so the account must be a member wherever it owns content.

The distinction therefore lives in two explicit records rather than in the namespace:

- **`added`** (`store.addedRecord`) says which memberships *we* created, so only a human's counts
  as an invitation. Its write order is a security property: record first, add second.
- **`Contributor.homePeer`** says we actually know which server the person is on, which only a
  linked server's directory can tell us. Without it, an account is attribution-only.

`person-` is keyed on the person's user id **on their own server**, so the same human resolves to
the same local account whether we meet them through a directory or a relayed photo.

## Display names — `markerName` and `UTILITY_SUFFIX`

Named by what the reader is doing when they see them.

An invite marker is a **destination** you pick in Immich's picker, so it names the person and the
server the album is going to: `Nan (via The Smiths server)`. An attribution account is a **photo
owner** you see in an album, so it keeps `UTILITY_SUFFIX` — `(via shared albums)`.

The two must never collide: a marker and a contributor can exist for the same remote person on the
same server, and two identically-named users are unpickable in the album picker.

## `personName` — recovering the human from a decorated name

Names travel on the wire. Stripping only `UTILITY_SUFFIX` let a marker's `(via X server)` ride
along as the "true" contributor, the receiver appended its own suffix, and the decoration
accumulated **one layer per relay hop** — `Nan (via B server) (via shared albums)`. `personName` is
greedy on purpose, so an already-doubled name collapses back to the person in one pass, and it
copes with household names that contain their own brackets.

## Startup order

`IMMICH_API_KEY` is read and checked **before** `CFG` is constructed. That is not style: proving it
there once means `CFG.apiKey` is a plain `string` everywhere instead of `string | undefined`, and it
removes a module-level `process.exit` that used to fire after the object already existed.
