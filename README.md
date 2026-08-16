# immich-shared-albums

[![e2e](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml/badge.svg)](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml)

Cross-household shared albums for [Immich](https://github.com/immich-app/immich) — a sidecar that lets families on **different Immich servers** share albums, contribute photos, and see each other's photos with full attribution, **using only the stock Immich apps**. No Immich source changes, no custom mobile app, no central service.

> Design discussion: [immich-app/immich#30794](https://github.com/immich-app/immich/discussions/30794)

## How it works (four sentences)

Albums are shared **by reference**: the album lives on its owner's server, and every participating household's sidecar maintains a local **mirror album** filled with full-quality copies owned by per-contributor utility users, so the stock app renders shared albums natively — right owner names and avatars in People, capture dates, GPS, full-resolution zoom and download, comments synced both ways. Joining is **per person**: opening a share link shows a join banner, you type your own server's address once, sign in, and the album is added to *your* account only — nobody else on your server sees it. Contributing is just "add photos to the album" in the stock app; they appear on the origin server credited to you. Sidecars talk over a small signed protocol; the share link *is* the introduction — its first redemption pins the joining household's key, and the owner can eject anyone.

## What each person experiences

| Person | Setup | Daily use |
|---|---|---|
| Household admin | 15 min, once: container + 2 proxy routes + API key | Mint share links in the stock app; rare moderation in the panel |
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

**Manual** — build the image from this repo, then add one container plus two proxy routes:

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
    handle {
        reverse_proxy immich-server:2283
    }
}
```

## Trust model, in one paragraph

Servers must be mutually and explicitly introduced — by share link, once per household pair — before a single byte flows; the introduction *is* the act of sharing an album, not a separate ritual. The first redemption pins the joining household's public key (anchored on the share key, which only invitees held); every subsequent request is signed, so URLs are mutable hints and a DDNS rename breaks nothing. All moderation is post-hoc and owner-side: remove a household, revoke a link, or forget a key. Default-closed: uninvited servers cannot so much as introduce themselves.

## Honest limitations

- **Contributing requires your server to be publicly reachable** (the origin fetches your photos from you at contribution time). View-only households need no public reachability.
- **Shared albums are stored as full copies** on every member server — that's what makes every household survive every other household's server dying, but budget disk for big albums (a preview-only storage mode is planned for constrained servers).
- Joining privately requires being signed in to your own Immich **web** UI in that browser once; the accept page walks you through it.
- On OAuth-only servers, provisioning the sidecar's utility users briefly toggles password login on and back off. If that bothers you, keep an eye on the issue tracker — an alternative is being considered.
- The share-page banner injects at the reverse proxy and **fails open**: if the sidecar dies or an Immich update changes internals, share pages keep working and only the cross-server convenience vanishes until patched.

## Status

Working v0, exercised daily across real households. Every push runs a 45-check headless end-to-end suite ([demo/e2e](./demo/e2e)) against three throwaway Immich instances in CI, plus a weekly run against `immich-server:release` to catch upstream breakage early. Covered: joins (per-user + re-join), full-original mirroring (checksum-verified) with attribution/avatars/dates/GPS, videos, contribution + uploader credit, member→member relay through the origin across three households, timeline cleanliness both ways, two-way comment sync with echo prevention, cross-album re-sharing, self-healing reconciliation with a cheap version handshake, and loop prevention. Architecture and protocol: [src/ARCHITECTURE.md](./src/ARCHITECTURE.md).
