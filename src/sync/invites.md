# Native album invitations

`invites.ts` — sharing an album by inviting a **person** in Immich's own picker.

A share link is how two servers meet; it should not be how every album afterwards is shared. Once
a server is linked, the native gesture does the work: every person on the linked server has a
local account here, and adding one to an album shares that album with them. Removing them revokes
it.

## Sharing names a person, never a household

There is deliberately no household-wide stand-in. A server link is not a person and has no
business impersonating one in a people picker — linking and unlinking a server is an admin act and
lives in [`p2p/unlink.ts`](../p2p/) and the panel.

Consequence worth knowing: `SHARE_USER_DIRECTORY=false` disables native invitations with that peer
entirely. Sharing names a person, so with no directory there is nobody to name. Share links still
work.

## Why detection asks as the marker, not with the admin key

`GET /albums` is **scoped per user**, so the admin key only ever sees the admin's own albums —
which is also why a non-admin cannot currently share cross-server at all (see the roadmap). Asking
as the marker sidesteps it: it does not matter who owns the album, only that the marker was
invited to it.

## Three Immich behaviours this code exists to survive

1. The album **owner** appears inside `albumUsers` with `role: 'owner'`. A marker that owns an
   album is a mirror we created for inbound content, not an invitation — those are skipped.
2. Adding a user who is **already** the owner returns **200** and is silently ignored. A 200 is
   never proof an invitation took; read `albumUsers` back instead.
3. `GET /albums` returns **no `ownerId`**. The owner is only discoverable inside `albumUsers`.

## What makes a membership mean "a human invited them"

This is the part that has broken twice, so it is worth stating precisely.

Detection reads "this account is a member of that album" as intent. That is only sound for
memberships the sidecar did not create itself — and the sidecar *does* add accounts to albums, for
attribution, whenever their owner contributes a photo. Two mechanisms keep the two apart:

- **`Contributor.homePeer`** is the invitability gate, and only a directory sync may set it. A ref
  carries the person's own user id but **not their home server**: for relayed content, `peer` is
  merely the hop it travelled through. Treating such an account as invitable would take an album a
  human shared with someone at D and hand it to C.
- **The `added` ledger** (`store.addedRecord`) records memberships we created. Its write order is a
  security property — record *before* the add, so a crash leaves a row with no membership (which
  makes us ignore an invitation) rather than a membership with no row (which reads as human intent
  and shares an album nobody offered).

On an **invitation** album the sidecar never writes membership at all: a human already added the
people they chose, so a missing one is a revocation, not a gap to fill. Filling it in was the
sidecar overruling the human, and it was the whole source of a revoke-versus-arriving-content race.
Link-shared albums are the opposite — the link named a household, nobody named a person — so
attribution has no membership to inherit and the sidecar does create one.

### The history, so it is not repeated

Conflating attribution accounts with invitation markers turned every link-shared album into a
bogus invitation (9 offered instead of 1). A later attempt gave one account both jobs, and origin
and member ping-ponged mirror/withdraw every poll, each offering the other a mirror of the other's
album.

## The trap if detection is ever rewritten

`seen.invited` drives **both** new-invite creation and the withdrawal check. Add a "no live
mapping" condition to that one set and every invitation is marked withdrawn the poll after it is
created. The two must stay separate: `memberOf` as the raw signal, *new* = memberOf minus live
mappings, *withdrawn* = live invite mappings minus memberOf.

## Multiple invitees

An invitation may name several people. `Mapping.forPeerUserIds` holds the whole set and the member
side follows it in both directions — people added upstream are added to the mirror, and a person
dropped while others remain is removed from it. Without that second half, revoking for one person
would appear to work and silently do nothing.

## Detection, step by step

`detectInvitesOnce` asks **one album list per invited person**, as that person's own account, and
unions the views. Two people from the same household invited to one album must mirror for both, so
every invitee is remembered, not just the first.

It **aborts the peer on any read failure**. A partial view is indistinguishable from a withdrawal,
and acting on one would retire live shares.

Within `albumsVisibleTo`:
- `role: 'owner'` means the album is a mirror we created for inbound content, not an invitation.
- A membership in the `added` ledger is ours, for attribution — not intent, however it looks.
- When a membership disappears, its ledger row is dropped, so a later hand-invite to that album
  reads as intent instead of matching a stale row forever.

New mappings are **read back after saving**. A silent persistence failure would otherwise mean
invitations are re-detected on every restart and withdrawals forgotten.

## Withdrawals apply to OWNER mappings only

The withdrawal sweep judges albums on *our* server by whether the peer's account is still a member.
Two constraints, each of which caused a bug when missing:

- Only `via: 'invite'` mappings are eligible. A link-redeemed mapping never had an account added to
  its album, so it is absent from this list **by design** — retiring it here silently unshares
  every link-based album.
- Only `role: 'owner'` mappings. A member mapping is a mirror we *received*; the peer's accounts
  were never members of it, so it always looks "withdrawn" here. Retiring it kills a live mirror one
  poll after the pull created it — a mirror/withdraw loop, not a withdrawal. Member mappings are
  retired by `pullInvitationsOnce`, against what the peer actually offers.

When a withdrawal fires, memberships **we** created are removed too. Otherwise Immich keeps showing
those people on an album this addon has stopped syncing, and because re-adding an existing member is
a no-op that produces no signal, the share could never be restored by hand.
