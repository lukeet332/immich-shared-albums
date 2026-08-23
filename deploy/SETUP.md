# The default setup — nothing on the internet

This is the recommended way to run immich-shared-albums. When you're done:

- your Immich stays exactly as private as it is today,
- you can share albums with another family and it feels native in the Immich app,
- and (optionally) you can send view-only links to people who don't run a server.

Nothing here requires a domain name, port forwarding, certificates, or router changes.

## 1. Install the addon next to Immich

```bash
git clone https://github.com/lukeet332/immich-shared-albums
cd immich-shared-albums && bash deploy/install.sh
```

The script finds your Immich, asks for an admin API key (Immich → Account settings → API keys),
starts the addon, and prints the reverse-proxy routes to add **on your own network** — they're how
the Immich app gets shared photos, and they can stay as private as Immich itself.

## 2. Link with the other family (once)

Both households install the addon, then:

1. You: open the admin panel (`https://<your-immich>/immich-shared-albums/`) → **Create pairing link**.
2. Send the code to the other family's admin — WhatsApp, text, anything. It's one line, expires in
   15 minutes, and works once.
3. They paste it into **their** panel's "Link a server" box. Done — linked both ways.

The two servers now talk to each other directly through their own encrypted tunnel, wherever they
are, with nothing exposed. (Behind the scenes this is [iroh](https://www.iroh.computer); if the
homes can't connect directly, traffic falls back through an encrypted public relay — set
`RELAY=off` if you'd rather it never did.)

## 3. Share like it's normal Immich — because it is

Open an album in the Immich app → share → **pick the person**. People from the linked server are
right there in the picker. The album appears on their server automatically, joined to their
account. Remove them from the album to unshare; unlink the server in the panel to end everything.

## 4. Optional: view-only links for people without a server

Grandma doesn't run Immich — she just wants to *look*. Add
[immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) as the one small public
piece. It shows Immich share links as a read-only gallery and exposes nothing else.

Point it at the **addon** (not Immich directly), so links to albums that contain photos shared
from other servers show the real photos too:

```yaml
immich-public-proxy:
  image: alangrainger/immich-public-proxy:latest
  environment:
    IMMICH_URL: http://immich-shared-albums:8300
  ports:
    - 3000:3000   # put your public HTTPS in front of this, and only this
```

Then, in the addon's panel, turn **"Allow other Immich users to join albums via shared links"**
off. Links are now strictly for viewing; joining another server to yours only ever happens through
a pairing code you created.

## What's public in this setup?

| | Reachable from the internet |
|---|---|
| Immich | no |
| The addon | no |
| Server-to-server sharing | no — the tunnel dials out; nothing listens |
| immich-public-proxy | yes — and it's the only thing, if you chose step 4 |

Prefer share links that strangers can *join* from (they see a join card on the album page)? That
needs your Immich publicly reachable — see the README's alternative setup. Same install; it's just
a choice.
