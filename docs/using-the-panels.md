# Using the panels — what you can do, and where

One URL is the whole surface: **`https://<your-immich>/immich-shared-albums/`**. Bookmark that.
Everything below is reached by clicking from there; nothing else needs typing.

You sign in with your own Immich account. The addon has no accounts of its own, and what a panel
shows you is scoped to you — an ordinary user never sees another person's albums or any server
setting.

## What opens depends on who you are

| Who you are           | What the one URL opens                                                         |
| :-------------------- | :----------------------------------------------------------------------------- |
| Anyone signed in      | **Your shared albums** — the albums you share across servers, and any reunions |
| An admin              | A choice of two: **Your shared albums**, or **Server settings and pairings**   |
| Someone not signed in | A prompt to sign in to your Immich                                             |

## Your shared albums (`/me`)

The personal panel. It answers: _what am I sharing, and with whom?_

- **Your shared albums** — every album you are part of that crosses servers, whether you shared it
  or someone shared it with you, and which server the other side lives on.
- **Possible album reunions** — albums that look like two halves of one Google Photos album. If you
  and a relative each imported a Takeout of "Summer 2024", that album shows up on both servers as a
  partial copy; this lists the pairs it finds, with how many photos each side holds and whether the
  dates line up. Each row says what you can do about it:
  - **Invite <name>** — shares YOUR album with them, so the reunion can start. This is the one
    sharing action the panel performs itself: it adds that one person to that one album, exactly as
    Immich's own picker would, and nothing else about sharing moves here.
  - **Accept invite** — they shared their half with you. Accepting takes their photos into the album
    you already own; it stays yours, and it can be undone.
  - **Invited … waiting** — you shared yours. There is nothing to click until they accept on their
    side.
  - A pair that has been reunited leaves this list and appears under **Reunified albums** instead.
- Opening this page is also what offers **the albums you own** to each connected server, so they can
  look for the other half of one. The pair appears for whoever opens their panel second, and for both
  of you on every visit after that — nothing is published until someone opens their own panel.
- **Reunified albums** — the ones you have merged, each with **Un-reunite**.

Reuniting changes no photo's ownership: each album stays its own owner's, on that owner's own
server, and the other side's photos arrive as shared copies rather than being copied. A photo both
of you hold is never shown twice.

Un-reuniting undoes the merge and nothing else — your album keeps your own photos, the other side's
copies are removed, and the share goes back to being an ordinary shared album. It is worth knowing
that the two matching albums are paired by **name alone**, because a Takeout carries no album dates
to compare; a name can be wrong, which is why the action is reversible.

## Server settings and pairings (`/admin`)

**Admins only** — this is the only surface that acts on the server rather than describing it.

- **Link a server** — mint a pairing code and send it to the other household. The code is
  single-use, expires, and carries no access to any photo on its own.
- **Connected servers** — who you are linked to, and unlink.
- **Shared albums** — the albums currently crossing servers.
- **Settings** — how long pairing codes stay valid, whether shared links may be joined, and the rest.

## Sharing an album (where it actually happens)

Sharing is done in **Immich's own app**, not here:

1. Open the album in Immich and tap **Share**.
2. Pick the person on the linked server. They appear by name, e.g. "Nan (via The Smiths server)".
3. Done. Remove them from the album to unshare it.

One exception, and it is narrow: **Invite** on a row under _Possible album reunions_ does the same
thing for that row's album and that row's person — one membership, on an album you own, for the
person the pair is about. It exists because the reunion cannot start without the share and the panel
is where the pair is shown. Everything else — every other album, every other person, and unsharing —
still happens in Immich, so nobody has to learn our surface to use their own photos.

## Joining an album someone shared with you (`/accept`)

When someone sends you a share link, the join card on that page hands you to
`/immich-shared-albums/accept`. Sign in to your own Immich there, accept, and the album fills with
the other server's photos. Anyone can reach this page; it does not require the addon's panels.

**If you already have an album with the same name**, the page offers to reunite the two instead of
joining separately — because joining separately is what would leave you holding two albums of one
name. Reuniting keeps the album yours, shows a photo you both hold once, and can be undone from your
shared-albums page afterwards. The other button joins as a separate album, which is the right choice
when the two albums only happen to share a name.

Albums that have been reunited carry a line in their own comments saying so, written by the addon's
"Shared albums" account rather than by the person who clicked. That is the record of what happened to
the album, and it is there because the two albums were paired by name alone — which can be wrong, and
only the people in the album can tell.

## Related

- [Setup guide](../deploy/SETUP.md) — installing and linking, step by step
- [Configuration](../deploy/configuration.md) — every setting and its default
- [Exposure](../deploy/exposure.md) — how public to make any of this
