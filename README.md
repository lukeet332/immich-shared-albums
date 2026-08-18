# immich-shared-albums

[![e2e](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml/badge.svg)](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml)

**It's finally here: cross-server shared albums for Immich!** (Hence the repo name, the code, and the over-excited sentence above.)

It's a Google Photos style experience for shared photo and video albums, except it works across separate servers. The goal is for it to feel native: no separate apps to install, no weird web config portals to set up.

It never touches or modifies any of the Immich team's code. It runs in its own isolated Docker container on your server and only talks to Immich over the API. We call that container the sidecar.

Between servers it sets up a secure handshake so the two can talk to each other. After that, a webhook (a signed HTTP request) pings the other server whenever something changes, so updates show up in seconds. A periodic check runs as a backup in case a nudge gets missed.

Joining needs a small bit of custom UI on the shared album page, so the sidecar injects an HTML overlay. I know, I know, I said it never touches the stock Immich UI. It doesn't: a reverse proxy intercepts the URL and the sidecar serves its own overlay, without changing anything on your actual Immich server. It doesn't change how sharing works either. It just uses the normal share links your server already makes.

Questions, suggestions and PRs are all welcome.

## What you get

- 🔗 **Simple link sharing.** Open a link, join, done. Works in the stock Immich apps, nothing to install on your phone.
- 👤 **Joins your account, not the whole server.** So your parents won't see your antics from that lads' holiday.
- 💾 **Your storage stays yours.** Photos stream from whoever owns them. All that lands on your disk is a tiny ~2KB placeholder per photo, whatever the album size, with full quality on demand.
- 💬 **Cross-server comments.** Both ways, near-instant, credited to whoever wrote them.
- 🎬 **Videos too.** Playable versions sync, originals stream on demand.
- 📦 **Isolated and self-hosted.** One small container, no forks, no patched Immich, no runtime dependencies. Runs fine on a Pi.

## See it in action

[![Watch the demo — two Immich servers sharing an album live](https://img.youtube.com/vi/c3GO-YFchYo/hqdefault.jpg)](https://www.youtube.com/watch?v=c3GO-YFchYo)

Two households, one shared album, created and shared and joined and commented on, all in the stock apps. Born from [this design discussion](https://github.com/immich-app/immich/discussions/30794). Full internals are in [ARCHITECTURE.md](./src/ARCHITECTURE.md).

## Install

- **Guided:** clone next to your Immich and run `bash deploy/install.sh`. It asks for your Immich network, public URL, household name and an API key, then builds, starts and health-checks the sidecar and prints the reverse-proxy lines you add.
- **Got an AI agent on the box?** Paste [deploy/INSTALL-AI.md](./deploy/INSTALL-AI.md) and it does the lot.
- **Manual:** one container plus three proxy routes (Caddy, nginx or Traefik). See [deploy/](./deploy/).

## Permissions & security

- **You choose how exposed your server is.** This addon doesn't open your server to the internet or change how sharing works; it only handles the server-to-server handshake. Each server just needs to reach the other's sidecar. A peer only ever touches `/sidecar/*` and `/share/*`, so the rest of Immich (all of `/api`, your library, admin) can stay private whichever way you set it up:
    - **Public domain over HTTPS.** The standard reverse-proxy setup under Install.
    - **[Tailscale](https://tailscale.com/) Funnel.** Funnel just `/sidecar/*` and `/share/*` to the sidecar over HTTPS. No domain and no open router ports needed.
    - **Fully hidden behind a Tailscale VPN.** Put every participating server on the same tailnet and nothing is exposed publicly at all. Ideal when the other households are on your tailnet too.
- **Your server's security is your responsibility.** This is a tool, and it's only as secure as the server you run it on.
- **Needs an admin API key** (all permissions). It creates its own bot users to own the placeholder photos, which is what keeps shared albums out of your own timeline while still showing the right name and avatar. Keep the key in `.env`.
- **It can't touch your photos.** It only ever deletes the placeholder stubs it made itself, and only when you leave an album. The delete code refuses any asset it doesn't own, so your real library is safe whatever the key can do.
- **Small attack surface.** Zero dependencies, plain Node plus the built-in `node:sqlite`, and a codebase you can read.
- **Closed by default.** Two servers have to be introduced by a share link before anything flows. After that every request is signed, and the owner can remove any household at any time.

## Good to know

- If a photo's owner server is offline you'll see placeholders until it's back (your device caches recent views). Your own library is never affected by someone else's downtime.
- New photos show up on the app's next sync, usually within seconds while it's open, or when you reopen it.
- Joining costs almost no storage, and leaving cleans it up. The sidecar notices the app's normal "Leave album" and removes everything the join created.

## Versioning

Semver with a sync-contract policy (a MAJOR bump means older peers can't sync with you). Versions are set automatically from commits, every change is gated on the e2e suite (66 checks plus a browser lane), and a weekly job runs against the latest Immich release to catch breakage early. See [CHANGELOG.md](./CHANGELOG.md).

## Support

If this saved your family from the cloud, you can say thanks:

[![Sponsor](https://img.shields.io/badge/❤-Sponsor_this_project-ea4aaa?style=for-the-badge)](https://github.com/sponsors/lukeet332)
