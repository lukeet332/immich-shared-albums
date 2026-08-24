# `sync/` — the reconciliation loops

The background engine that keeps mirrors up to date in both directions. Runs on timers;
also driven on demand by nudges (`../p2p/protocol.ts`) so changes land in seconds.

| File          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invites.ts`  | **Native album invitations, per person.** Every person on a linked server gets a local marker user; adding one to an album in Immich's own picker shares that album with that person, and removing them revokes it. The origin detects this by listing albums as each marker; members discover it by polling the `/invitations` peer route (over iroh). Server _linking_ is not here — it is admin-owned, in [`p2p/unlink.ts`](../p2p/) and the panel. |
| `engine.ts`   | Photo sync. `watchOnce` pushes local additions out to peers; `reconcileOnce`/`reconcileMapping` pull the origin manifest, materialise anything missing, and **propagate deletions** (with a consistency gate so an indexing lag never wrongly deletes). `startWatchLoop` runs it on an overlap-guarded interval.                                                                                                                                       |
| `leave.ts`    | `leaveAlbum` — the full reverse of a join: purges every stub, the mirror album, the mapping and its ledger.                                                                                                                                                                                                                                                                                                                                            |
| `comments.ts` | Cross-server comments. The origin album is the source of truth: members pull the canonical list and push their own, gated by a cheap activity-count statistic so messages land in seconds without heavy polling. Includes the inbound `handleActivity`/`handleComments` handlers. `startCommentLoop` runs the fast lane.                                                                                                                               |

**Why loops and not just webhooks:** nudges make the common case instant, but the timed
sweep is the safety net — a lost nudge costs nothing because the next scheduled handshake
catches everything (fail-open by design). `ISA_RECONCILE_DEBUG=1` traces every decision.

## Why sharing is per person, and links are not shareable objects

Sharing names a **person**, never a whole server. A server link is not a person, so it gets no
marker user and never appears in Immich's people picker; it is created by redeeming a share link
and destroyed from the panel (`…/unlink`). This also means `ISA_PUBLISH_USER_DIRECTORY=false` disables
native invitations with that peer — with no directory there is nobody to name — and share links
remain the way in.

An invitation may name several people. `Mapping.forPeerUserIds` holds the whole set, and the
member side follows it in both directions: people added upstream are added to the mirror, and a
person dropped while others remain is removed from it. Without that second half a revocation for
one person would appear to work and silently do nothing.

## Why invitations are detected as the marker, not with the admin key

`GET /albums` is scoped per user, so the admin key only ever sees the admin's own albums —
which is exactly why a non-admin cannot share cross-server through a share link today. Asking
_as the stand-in_ sidesteps it: it does not matter who owns the album, only that the stand-in
was invited to it.

Three Immich behaviours this has to allow for:

- the album **owner** appears inside `albumUsers` with `role: 'owner'`, and `GET /albums`
  returns no `ownerId` at all — so the owner is only discoverable there;
- a stand-in that _owns_ an album is a mirror we created for inbound content, not an
  invitation, so those are skipped;
- adding a user who is already the owner returns **200 and is silently ignored**, so a 200 is
  never proof an invitation took. Read `albumUsers` back.

## Provenance is load-bearing

`Mapping.via` records whether a share came from a link or an invitation, and two rules depend
on it:

1. **Only `via: 'invite'` mappings may be retired** when a stand-in vanishes from an album. A
   link-redeemed mapping never had a stand-in added to its album, so it is absent from that
   list by design — retiring those here would silently unshare every link-based album.
2. **Only `via: 'invite'` mappings are offered** on the `/invitations` peer route. Offering link ones
   would re-mirror albums the member already handled through `join`, and worse, would silently
   undo `leaveAlbum` on the next poll, because leaving removes the member's mapping but not the
   origin's.

Invitations are **pulled**, never pushed: a member with no inbound reachability still syncs
perfectly well by pulling, so a push-based invitation would fail for exactly the households
that most need this.
