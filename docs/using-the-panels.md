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
  dates line up.

Nothing on this page changes an album. It is a view, and every action it describes is confirmed by
both album owners before anything moves.

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

That is deliberate: the addon adds no second way to share, so nobody has to learn our surface to
use their own photos.

## Joining an album someone shared with you (`/accept`)

When someone sends you a share link, the join card on that page hands you to
`/immich-shared-albums/accept`. Sign in to your own Immich there, accept, and the album fills with
the other server's photos. Anyone can reach this page; it does not require the addon's panels.

## Related

- [Setup guide](../deploy/SETUP.md) — installing and linking, step by step
- [Configuration](../deploy/configuration.md) — every setting and its default
- [Exposure](../deploy/exposure.md) — how public to make any of this
