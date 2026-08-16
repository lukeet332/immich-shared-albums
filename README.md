# immich-shared-albums

[![e2e](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml/badge.svg)](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml)

**Share albums across Immich servers — Google-Photos-easy sharing, except every family keeps their own server, their own photos, their own rules.**

Your household runs Immich. So do the grandparents, and your sister across town. Until now those were islands: sharing meant public links or giving family accounts on *your* server (and your disk, and your responsibility). This sidecar joins the islands — share an album with a link, and it appears **natively in everyone's own Immich app**, photos landing in seconds, credited to whoever took them, comments flowing both ways.

- 📱 **Stock apps only** — nothing to install on any phone; albums, People, avatars, comments all render natively
- ⚡ **Fast** — photos and messages cross servers in seconds (verified end-to-end, nudged sync + cheap handshakes)
- 🖼️ **Full quality on demand** — light previews at rest; tap download and the true original streams straight from its owner's server
- 🔒 **Private by person, not by server** — joining adds the album to *your* account only; housemates can't even see it exists unless invited
- 🏠 **Photos live in the house that took them** — no central service, no cloud, no other family's terabytes on your disk
- 🎬 **Videos too** — playable renditions sync, originals on demand
- 🛡️ **Built to fail soft** — if a sidecar dies, Immich keeps working untouched; sync self-heals when it returns; albums never go blank, even if another family's server is gone for good
- 🍓 **Tiny** — one zero-dependency container (TypeScript on Node, SQLite state), happy on a Raspberry Pi

> Born from this design discussion: [immich-app/immich#30794](https://github.com/immich-app/immich/discussions/30794). No Immich source changes — everything rides the public API and your reverse proxy.

## How it works (four sentences)

Albums are shared **by reference**: each photo stays on its owner's server ("photos live in the house that took them"), and every participating household's sidecar maintains a local **mirror album** of preview-grade proxies owned by per-contributor utility users, so the stock app renders shared albums natively — right owner names and avatars in People, capture dates, GPS, comments synced both ways. Tapping download (or deep-zooming) streams the **full original live from the owner's server** through the originals-proxy route — full quality on demand, without storing anyone else's originals. Joining is **per person**: opening a share link shows a join banner, you type your own server's address once, sign in, and the album is added to *your* account only — nobody else on your server sees it. Contributing is just "add photos to the album" in the stock app; they appear on the origin server credited to you. Sidecars talk over a small signed protocol; the share link *is* the introduction — its first redemption pins the joining household's key, and the owner can eject anyone.

## What each person experiences

| Person | Setup | Daily use |
|---|---|---|
| Household admin | 15 min, once: container + 3 proxy routes + API key | Mint share links in the stock app; rare moderation in the panel |
| Someone joining an album | One-time per album: open link → type own server → sign in → Accept | Stock app only: view, add, comment, download |
| Everyone else on any server | **Nothing** — they can't even see the album unless invited | — |

## Install (per household)

**Easiest — guided script** (from a clone of this repo, next to your existing Immich):

```bash
git clone https://github.com/lukeet332/immich-shared-albums
cd immich-shared-albums && bash deploy/install.sh
```

It asks for your Immich network, public URL, household name, and an admin API
key, then builds, starts, health-checks the sidecar, and prints the two
reverse-proxy lines you still add yourself.

**Have an AI agent on the server?** Paste the prompt in
[deploy/INSTALL-AI.md](./deploy/INSTALL-AI.md) and it will discover your setup,
install, and verify — asking you only for the public URL, a household name, and
an API key.

**Manual** — build the image from this repo, then add one container plus three proxy routes:

```bash
git clone https://github.com/lukeet332/immich-shared-albums && cd immich-shared-albums
docker build -t immich-shared-albums:live .
```

```yaml
# docker-compose.override.yml (next to your Immich compose file)
services:
  immich-shared:
    image: immich-shared-albums:live
    restart: always
    environment:
      IMMICH_URL: http://immich-server:2283
      IMMICH_API_KEY: ${SIDECAR_API_KEY}   # admin API key, all permissions — keep it in .env
      PUBLIC_URL: https://photos.example.com
      HOUSEHOLD_NAME: "The Example household"
      # optional: PORT (8300), DATA_DIR (/data), POLL_MS (20000), ALBUM_TEMPLATE ("{name}")
    volumes:
      - ./sidecar-data:/data
```

Reverse proxy (Caddy shown; nginx/Traefik equivalents in `deploy/`):

```caddy
photos.example.com {
    handle /sidecar/* {
        reverse_proxy immich-shared:8300
    }
    # optional module: join-banner on share pages
    handle /share/* {
        reverse_proxy immich-shared:8300
    }
    # originals-proxy: full-quality downloads stream live from the photo's owner
    handle /api/assets/*/original {
        reverse_proxy immich-shared:8300
    }
    handle {
        reverse_proxy immich-server:2283
    }
}
```

## Versioning

Releases follow semver with a **sync-contract policy**: a **MAJOR** bump means a peer
on the previous version can no longer sync with you or the upgrade needs operator
action; **MINOR** adds features old peers tolerate; **PATCH** fixes. Watch the repo's
releases to hear about breaking changes — details in [CHANGELOG.md](./CHANGELOG.md).
Tagged releases publish a multi-arch image (amd64/arm64) to
`ghcr.io/lukeet332/immich-shared-albums`.

## Trust model, in one paragraph

Servers must be mutually and explicitly introduced — by share link, once per household pair — before a single byte flows; the introduction *is* the act of sharing an album, not a separate ritual. The first redemption pins the joining household's public key (anchored on the share key, which only invitees held); every subsequent request is signed, so URLs are mutable hints and a DDNS rename breaks nothing. All moderation is post-hoc and owner-side: remove a household, revoke a link, or forget a key. Default-closed: uninvited servers cannot so much as introduce themselves.

## Good to know

- **Contributing photos needs your server to be publicly reachable** (others fetch your photos from you — that's the point). Viewing-only households can stay fully private/tailnet-only.
- **Full-quality zoom/download needs the photo owner's server online**; while it isn't, you get the stored preview. Albums themselves always render — everyone holds real local copies.
- **Joining privately means signing in to your own Immich web UI once** in that browser; the accept page walks you through it and remembers you after.
- **New photos show in the mobile app on its next sync** — usually seconds while the app is open, or on reopen. That's the stock Immich app's sync cadence (identical for same-server shared albums); the photos are on your server long before the app repaints.

## Status

**In daily use across real households.** TypeScript run natively by Node (no build step), zero runtime dependencies, SQLite state via the built-in `node:sqlite` — light enough for a Raspberry Pi. Every push runs a 54-check headless end-to-end suite ([demo/e2e](./demo/e2e)) against three throwaway Immich instances in CI, plus a weekly run against `immich-server:release` to catch upstream breakage early. Covered: joins (per-user + re-join), preview-grade mirroring with attribution/avatars/dates/GPS, on-demand originals streamed byte-identical from the owner (including chained through the origin for relayed photos), videos as playable renditions, contribution + uploader credit, member→member relay across three households, timeline cleanliness both ways, canonical comments owned by the origin (two-way sync, echo prevention, relay + backfill to late joiners), cross-album re-sharing, self-healing reconciliation with a cheap version handshake, and loop prevention. Architecture and protocol: [src/ARCHITECTURE.md](./src/ARCHITECTURE.md).

## Support the project

If cross-server albums saved your family from the cloud, you can say thanks here:

[![Sponsor](https://img.shields.io/badge/❤-Sponsor_this_project-ea4aaa?style=for-the-badge)](https://github.com/sponsors/lukeet332)

Every contribution goes toward testing against new Immich releases and keeping the
weekly compatibility canary green.
