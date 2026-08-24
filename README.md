<p align="center">
  <br/>
  <a href="https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml"><img src="https://github.com/lukeet332/immich-shared-albums/actions/workflows/e2e.yml/badge.svg" alt="e2e"/></a>
  <a href="https://github.com/sponsors/lukeet332"><img src="https://img.shields.io/badge/❤-Sponsor-ea4aaa?style=for-the-badge&logoColor=000000&labelColor=ececec" alt="Sponsor"/></a>
  <br/>
  <br/>
</p>

<!-- v1: logo goes here
<p align="center">
<img src="design/logo.svg" width="300" title="immich-shared-albums">
</p>
-->
<h1 align="center">immich-shared-albums</h1>
<h3 align="center">Shared photo and video albums across separate Immich servers</h3>
<br/>

<!-- v1: screenshot banner goes here
<a href="https://www.youtube.com/watch?v=c3GO-YFchYo">
<img src="design/screenshots.png" title="Screenshots">
</a>
-->
<p align="center">
<a href="https://www.youtube.com/watch?v=c3GO-YFchYo">
<img src="https://img.youtube.com/vi/c3GO-YFchYo/hqdefault.jpg" title="Watch the demo — two Immich servers sharing an album live"/>
</a>
</p>

> [!WARNING]
> ⚠️ Pre-1.0 and under very active development. Expect breaking changes between versions, and always follow a [3-2-1](https://www.backblaze.com/blog/the-3-2-1-backup-strategy/) backup plan for your precious photos and videos!

> [!NOTE]
> The recommended setup exposes nothing to the internet. The walkthrough is at [deploy/SETUP.md](./deploy/SETUP.md).

## Links

- [Setup guide](./deploy/SETUP.md)
- [Demo video](https://www.youtube.com/watch?v=c3GO-YFchYo)
- [Features](#features)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Security](#security)
- [Documentation](#documentation)
- [Contributing](./AGENTS.md)
- [Changelog](./CHANGELOG.md)
- [The design discussion it was born in](https://github.com/immich-app/immich/discussions/30794)

## Documentation

| Doc | What it answers |
| :--- | :--- |
| [Setup guide](./deploy/SETUP.md) | the recommended install, step by step, nothing on the internet |
| [AI-agent install](./deploy/INSTALL-AI.md) | paste-into-your-agent instructions that adapt to any reverse proxy |
| [Manual install](./deploy/) | compose example, Caddy snippet, the three proxy routes |
| [Hardening guide](./deploy/exposure.md) | if you host publicly: pick an exposure level, paste one block |
| [Architecture](./src/ARCHITECTURE.md) | the whole design on one page — components, data flow, iron rules |
| [Wire protocol](./src/p2p/wire-protocol.md) | how two servers pair, share and stream, and what the connection proves |
| [Sync loops](./src/sync/sync-loops.md) | how albums, invitations and withdrawals reconcile |
| [Byte path](./src/media/hotlink-bytes.md) | where the actual pixels come from when you view a shared photo |
| [HTTP surface](./src/web/http-router.md) | every route the addon serves, and who may call it |
| [Immich API layer](./src/immich/local-immich-api.md) | the accounts the addon creates and the Immich quirks it absorbs |
| [Configuration reference](./deploy/configuration.md) | every setting, its default, and when to change it |
| [Contributing](./AGENTS.md) | the working contract for humans and AI agents — conventions, tests, invariants |
| [Demo rig](./demo/) | three complete households in Docker, plus the e2e suites that gate every change |

## Demo

Two households, one shared album. Created, shared, joined and commented on, all in the stock Immich apps: [watch the demo](https://www.youtube.com/watch?v=c3GO-YFchYo).

## Features

| Features                                                      | Stock apps | Notes                                    |
| :------------------------------------------------------------ | ---------- | ---------------------------------------- |
| Share an album with a person on another Immich server         | Yes        | picked in Immich's own share menu         |
| Albums join a person, not a whole server                      | Yes        | your parents won't see the lads' holiday  |
| Nothing exposed to the internet                               | Yes        | servers connect directly, dialling out    |
| Link two servers with a one-line pairing code                 | Yes        | works once, expires in 15 minutes         |
| Shared photos cost ~2KB of your disk each                     | Yes        | full quality streams from the owner       |
| Cross-server comments                                         | Yes        | both ways, credited to the writer         |
| Videos                                                        | Yes        | playable versions sync, originals stream  |
| Public view-only share links                                  | Yes        | via [immich-public-proxy](https://github.com/alangrainger/immich-public-proxy), optional |
| Joinable public share links                                   | Yes        | optional, if you host Immich publicly     |
| Unshare / unlink cleans everything up                         | Yes        | leaving an album works from the app too   |
| Runs on a Raspberry Pi                                        | —          | one small container, one pinned dependency |

## How it works

The addon runs in its own Docker container next to Immich and talks to it over the normal API. It never modifies Immich itself. If the addon dies, Immich carries on as if it was never there.

To reach the other family's server, the two addons open an encrypted connection directly to each other (built on [iroh](https://www.iroh.computer)). Each server is addressed by a cryptographic key rather than a URL, and the connection finds its way through home routers on its own. That is why neither side needs to expose anything: the servers dial out, nothing listens.

When someone shares an album with you, your server creates a lightweight copy: real album, real rows in your Immich, but each photo is a tiny placeholder. When you look at a photo, the full-quality version streams live from the owner's server. Nobody accumulates copies of anyone else's library, and if the owner stops sharing, the photos are simply gone.

## Setup

You need Docker, an Immich admin API key, and a reverse proxy in front of Immich on your own network. The addon sits behind three small proxy routes so the stock app can fetch shared photos. None of it has to be reachable from the internet. Full walkthrough: [deploy/SETUP.md](./deploy/SETUP.md).

1. **Install the addon** on both servers. Options, easiest first:
   - Point an AI coding agent (Claude Code, Cursor, etc.) at [deploy/INSTALL-AI.md](./deploy/INSTALL-AI.md). It adapts the proxy routes to whatever reverse proxy you run.
   - Run `bash deploy/install.sh`. It detects your Immich, starts the addon and prints the routes to add.
   - Or do it by hand: see [deploy/](./deploy/).
2. **Link the two servers.** Open the admin panel, click *Create pairing link*, and send the code to the other family over WhatsApp or wherever. Their admin pastes it into their panel.
3. **Share an album.** Open it in Immich, tap share, pick the person. Done. Remove them from the album to unshare, or unlink the whole server from the panel.

### Public share links (optional)

Want to send view-only links to people who don't run a server? Add [immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) as the one public piece of your setup. It renders share links as a read-only gallery and exposes nothing else. Point its `IMMICH_URL` at this addon instead of Immich and shared photos from other servers show up in those links too. You can then turn off *"Allow other Immich users to join albums via shared links"* in the panel, so links are strictly for looking at.

If your Immich is already public, share links do more: the album page shows a join card, and a visitor who runs this addon can join the album from it. Same install, one panel setting.

## Configuration

Two settings matter when you install; everything else has a working default (full list in
[deploy/configuration.md](./deploy/configuration.md)).

| Variable | What to put there |
|---|---|
| `IMMICH_API_KEY` | **Required.** An API key from an admin account, created with the permissions below. |
| `HOUSEHOLD_NAME` | The name the other family sees, e.g. `The Smiths`. |

### The API key

In Immich: *Account settings → API keys → New API key*, then tick exactly these permissions.
The addon checks the key when it starts and tells you if anything is missing. (`all` also works,
but then a leaked key could do anything — this list can't touch your photos or settings.)

| Permission | Why the addon needs it |
| :--- | :--- |
| `adminUser.create` / `read` / `update` / `delete` | creates and manages the bot accounts that hold shared photos, so they stay out of your own timeline |
| `album.read` | reads the albums it syncs |
| `albumUser.create` / `update` / `delete` | adds those bot accounts to albums, so shared photos show the right owner |
| `asset.read` | lists what's in an album |
| `asset.view` / `asset.download` | streams your photos to the family you shared them with |
| `activity.read` / `activity.statistics` | syncs comments both ways |
| `user.read` | shows the right names |
| `userProfileImage.read` | syncs avatars, so shared photos show the right face |
| `sharedLink.read` | resolves a share link when someone joins with one |
| `systemConfig.read` / `update` | **only if your Immich is OAuth-only** — briefly toggles password login to set up the bot accounts |

## Security

Your server stays as private as it is today, the two servers prove their identity to each other cryptographically, and the addon is built so that even its own credentials can't do much damage.

- Server-to-server traffic only ever flows between servers that were deliberately paired, over an end-to-end encrypted connection. There is no server-to-server HTTP at all.
- The pages you use (panel, joining) require you to be signed in to your own Immich. The addon has no accounts or passwords of its own.
- Every photo request from another server is checked against what was actually shared with them. Reaching an endpoint is never permission to use it.
- The API key doesn't need `all` — see [the permission table](#the-api-key). Scoped like that, a leaked key can't delete or edit photos, can't change settings, and can't create a broader key.
- The addon can't touch your photos. The only assets it ever deletes are the placeholder stubs it created itself, and the delete code refuses anything it doesn't own.
- Share links are bearer credentials, same as in stock Immich: whoever has the link (and its password, if set) can use it. Treat them accordingly, or keep link-joining switched off.
- Small surface: plain Node, the built-in `node:sqlite`, one pinned dependency, a codebase you can read. [deploy/exposure.md](./deploy/exposure.md) covers hardening if you host publicly.

## Good to know

- If a photo's owner is offline you'll see placeholders until they're back. Recently viewed photos survive from cache. Your own library is never affected.
- New photos show up on the app's next sync, usually within seconds.
- Leaving an album cleans up everything the join created. The addon notices the app's normal "Leave album" too.

## Versioning

Semver, where a major bump means older peers can't sync with you. Versions come from commits automatically and every change is gated on the e2e suite plus a browser lane. A weekly run against the latest Immich release catches breakage early. See [CHANGELOG.md](./CHANGELOG.md).

## Support the project

Questions, suggestions and PRs are all welcome. And if this saved your family from the cloud, you can say thanks:

<a href="https://github.com/sponsors/lukeet332"><img src="https://img.shields.io/badge/❤-Sponsor_this_project-ea4aaa?style=for-the-badge" alt="Sponsor"/></a>
