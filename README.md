# immich-shared-albums

[![e2e](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml/badge.svg)](https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml)

**It's finally here: cross-server shared albums for Immich!** (Hence the repo name, the code, and the over-excited sentence above.)

It's a Google Photos style experience for shared photo and video albums, except it works across separate servers. The goal is for it to feel native: no separate apps to install, no weird web config portals to set up.

It never touches or modifies any of the Immich team's code. It runs in its own isolated Docker container on your server and only talks to Immich over the API. We call that container the sidecar.

Between servers it speaks [iroh](https://www.iroh.computer) — an encrypted peer-to-peer QUIC connection that dials the other server's *key*, not an address, hole-punching through NATs so neither home needs a public domain, port forwarding, or any exposed service. When something changes, a nudge over that connection makes updates land in seconds; a periodic check runs as a backup.

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

Every method needs Docker, an admin API key, and **a reverse proxy in front of Immich**. Shared photos and the join banner reach your server through three small routes (`/immich-shared-albums/*`, `/share/*`, and the GET byte routes) placed ahead of your normal Immich route. Pick one, easiest first:

- **Preferred: let an AI agent install it.** If you use an AI coding agent (Claude Code, Cursor, Copilot CLI, etc.), either on the server or on your own machine with SSH access to it, paste [deploy/INSTALL-AI.md](./deploy/INSTALL-AI.md). It discovers your setup, installs the sidecar, adds the proxy routes adapted to *your* reverse proxy, and verifies the result. It's the most hands-off option and the only one that adapts to any proxy (Caddy, nginx, NPM, Traefik, tunnels).
- **Guided script.** No agent? Clone next to your Immich and run `bash deploy/install.sh`. It auto-detects your Immich network, builds and starts the sidecar, health-checks it, and prints the proxy routes for you to add.
- **Manual.** Build the container and add the three routes yourself. See [deploy/](./deploy/).

### Configuration

Only two are required. The rest have working defaults, so set them only if you need to.

| Variable | Default | What it does |
|---|---|---|
| `IMMICH_API_KEY` | — | **Required.** Admin API key. The addon refuses to start without one. |
| `HOUSEHOLD_NAME` | `Unnamed household` | The name peers see, and the name mirrored albums are attributed to. |
| `IMMICH_URL` | `http://immich-server:2283` | Your Immich, from inside the container. |
| `PORT` | `8300` | Port the addon listens on. |
| `DATA_DIR` | `/data` | Where `state.db` lives. Back this up; it holds your signing key. |
| `REQUIRE_SHARE_PASSWORD` | `false` | Refuse to link with a server whose share link has no password. **Recommended if you are publicly reachable** — otherwise possession of a link is the whole credential. A link's own password and expiry are always enforced regardless. |
| `SHARE_USER_DIRECTORY` | `true` | Share your users' **names** (never emails) with linked servers, so they can invite a specific person. Set `false` to keep your user list private — that disables native invitations with that server, leaving share links. |
| `RELAY` | on | Relays assist hole-punching and carry end-to-end-encrypted traffic when a direct path fails (n0's public relays — the one third party, used as a fallback only). `off` runs fully dark: direct connections only. |
| `ALBUM_TEMPLATE` | `{name}` | Naming for mirrored albums, e.g. `{name} (shared)`. |
| `CACHE_MAX_MB` | `512` | Bounded cache for viewed photos. `0` disables. Delete the folder any time — it is a cache, not storage. |
| `UTILITY_QUOTA_MB` | `0` (none) | Storage cap on the addon's bot accounts. Bounds what a stolen key could write, but too low and syncing silently fails. |
| `MAX_BODY_KB` | `1024` | Hard cap on any request body the addon buffers. |
| `POLL_MS` | `20000` | How often it checks peers for changes. |

## Permissions & security

- **You choose how exposed your server is.** This addon doesn't open your server to the internet or change how sharing works; it only handles the server-to-server handshake. Each server just needs to reach the other's sidecar. A peer only ever touches `/immich-shared-albums/*` and `/share/*`, so the rest of Immich (all of `/api`, your library, admin) can stay private whichever way you set it up:
    - **Public domain over HTTPS.** The standard reverse-proxy setup under Install.
    - **[Tailscale](https://tailscale.com/) Funnel.** Funnel just `/immich-shared-albums/*` and `/share/*` to the sidecar over HTTPS. No domain and no open router ports needed.
    - **Fully hidden behind a Tailscale VPN.** Put every participating server on the same tailnet and nothing is exposed publicly at all. Ideal when the other households are on your tailnet too.
- **Your server's security is your responsibility.** This is a tool, and it's only as secure as the server you run it on. [deploy/exposure.md](./deploy/exposure.md) is a short, practical guide: pick how exposed you want to be, then paste one hardening block.
- **Nothing is protected by being hard to reach.** Every route assumes it's on the open internet. Pages you use (the panel, joining, leaving) require you to be **signed in to your own Immich** — the sidecar has no accounts of its own and checks your session against Immich itself. Server-to-server traffic rides mutually authenticated, end-to-end-encrypted QUIC — a connection is only possible from a paired key — *and* every byte read checks that the asking household was actually offered that album and that photo. Being able to reach an endpoint is never permission to use it.
- **Share links keep their own rules.** A password-protected link needs that same password to join across servers, and an expired link won't join at all. Set `REQUIRE_SHARE_PASSWORD=true` to refuse links that have no password — worth it on a public domain, because otherwise a forwarded link is the whole credential.
- **Needs an admin API key** (all permissions), because it creates the bot users that own the placeholder photos — that's what keeps shared albums out of your own timeline while still showing the right name and avatar. Keep the key in `.env`. Those bot users are **not** admins, get a narrowly-scoped key, and have no password kept anywhere, so nobody can sign in as them.
- **It can't touch your photos.** It only ever deletes the placeholder stubs it made itself, and only when you leave an album. The delete code refuses any asset it doesn't own, so your real library is safe whatever the key can do.
- **Small attack surface.** Zero dependencies, plain Node plus the built-in `node:sqlite`, and a codebase you can read.
- **Closed by default, with one caveat worth knowing.** Two servers have to be introduced — a pairing string or a share link — before anything flows; every later connection is mutually authenticated on the pinned keys, and the owner can remove any household at any time. The caveat: a share link is a *bearer* credential — whoever holds it (and its password) can introduce their server. Treat album links like you'd treat any link that grants access.

## Good to know

- If a photo's owner server is offline you'll see placeholders until it's back (your device caches recent views). Your own library is never affected by someone else's downtime.
- New photos show up on the app's next sync, usually within seconds while it's open, or when you reopen it.
- Joining costs almost no storage, and leaving cleans it up. The sidecar notices the app's normal "Leave album" and removes everything the join created.

## Versioning

Semver with a sync-contract policy (a MAJOR bump means older peers can't sync with you). Versions are set automatically from commits, every change is gated on the e2e suite (100 checks plus a browser lane, 18 of them security regressions), and a weekly job runs against the latest Immich release to catch breakage early. See [CHANGELOG.md](./CHANGELOG.md).

## Support

If this saved your family from the cloud, you can say thanks:

[![Sponsor](https://img.shields.io/badge/❤-Sponsor_this_project-ea4aaa?style=for-the-badge)](https://github.com/sponsors/lukeet332)
