# immich-shared-albums

Cross-household shared albums for [Immich](https://github.com/immich-app/immich) — a sidecar that lets families on **different Immich servers** share albums, contribute photos, and save each other's originals, **using only the stock Immich apps**. No Immich source changes, no custom mobile app, no central service.

> Design discussion: [immich-app/immich#30794](https://github.com/immich-app/immich/discussions/30794)

## How it works (three sentences)

Albums are shared **by reference**: each photo stays on its owner's server ("photos live in the house that took them"), and every participating household's sidecar maintains a local **mirror album** filled with preview-grade proxy assets, so the stock app renders shared albums natively. Contributing is "add photos to the 🔗 album"; saving is "add their photo to one of my albums" (the sidecar swaps in the full original, owned by you) or just tapping download. Sidecars talk to each other over a small signed protocol; households are introduced by an ordinary Immich share link — possession of the link is the authorisation, the first contribution pins the household's key, and the owner can eject anyone from the panel.

## What each person experiences

| Person | Setup | Daily use |
|---|---|---|
| Household admin | 15 min, once: container + 3 Caddy lines + API key | Mint share links in the stock app; rare moderation in the panel |
| Everyone else in any household | **Nothing** | Stock app only: view, add, save, download |

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

**Manual** — one container plus two proxy routes:

```yaml
# docker-compose.override.yml
services:
  immich-shared:
    image: ghcr.io/lukeet332/immich-shared-albums:latest
    restart: always
    environment:
      IMMICH_URL: http://immich-server:2283
      IMMICH_API_KEY: ${SIDECAR_API_KEY}
      PUBLIC_URL: https://photos.example.com
      HOUSEHOLD_NAME: "The Example household"
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
    # optional module: full-quality originals for shared photos
    handle_path /api/assets/*/original {
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

- **Contributing by reference requires your server to be publicly reachable** (custody means answering the door). Private/tailnet-only households can join, view, and save — and contribute by uploading copies instead.
- In-app viewing tops out at preview quality (~1440px) unless the optional originals module is routed; save/download always fetch true originals.
- Videos sync as previews/posters in v0; full video streaming is planned.
- The share-page banner and originals module inject/intercept at the reverse proxy and **fail open**: if an Immich update changes internals, share pages keep working and only the convenience vanishes until we patch.

## Status

Early scaffold. Protocol and design are settled (see README-DESIGN.md); implementation is in progress. Not yet ready for use.
