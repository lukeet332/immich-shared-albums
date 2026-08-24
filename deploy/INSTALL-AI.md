# AI-assisted install

> 🎬 What you get once installed: [2-minute demo of two servers sharing an album](https://www.youtube.com/watch?v=c3GO-YFchYo).

Running an AI coding agent (Claude Code, Copilot CLI, Cursor, …) with access to
the machine that hosts your Immich, either on the box itself or SSH'd in from
your own machine? Paste the prompt below and it will do the install for you,
adapted to *your* setup, asking you only for the things it can't discover.

---

## Prompt to paste

```text
Install the immich-shared-albums sidecar (https://github.com/lukeet332/immich-shared-albums)
next to my existing Immich server. It adds cross-server shared albums: one extra
container plus three reverse-proxy routes. Follow this plan:

DISCOVER (do this yourself, don't ask me):
1. Find my Immich deployment: locate its docker-compose file, the docker network
   its containers share, and the container name / internal URL of immich-server
   (usually http://immich-server:2283).
2. Find my reverse proxy (Caddy, nginx, Traefik, or none) and the config file
   that serves my public Immich domain.
3. Confirm docker and git are available.

ASK ME (only these):
1. A household name to show to peers (e.g. "The Smith household").
2. An Immich admin API key. I create it in Immich web -> Account Settings ->
   API Keys -> New API Key, ticking exactly the permissions listed in
   deploy/api-key.md of the repo (read it; 'all' also works but is broader than
   needed). The addon verifies the key at startup and logs anything missing.
   (If password login is disabled on my server because I use OAuth, tell me the
   scoped list needs systemConfig.read+update added, and why.)
3. Whether I want PUBLIC view-only share links. If yes, also install
   immich-public-proxy in the same compose file, with
   IMMICH_URL: http://immich-shared-albums:8300 (the addon, NOT immich-server —
   that is what makes photos shared from other servers render full quality),
   and tell me the two follow-ups: put my public HTTPS in front of only the
   proxy's port, and set Immich's Administration -> Settings -> Server ->
   External domain to that public address.

INSTALL:
1. git clone https://github.com/lukeet332/immich-shared-albums
2. Either run `bash deploy/install.sh` interactively with me, or replicate what
   it does: build the image, write a compose file joining the sidecar to the
   Immich docker network with env IMMICH_URL, IMMICH_API_KEY (in a chmod-600
   .env file, never in the yml), HOUSEHOLD_NAME, and a ./data
   volume for /data. Start it with docker compose up -d.
3. Add these three routes to my reverse proxy BEFORE the catch-all Immich route,
   then reload the proxy:
     /immich-shared-albums/*                                       -> sidecar :8300
     /share/*                                         -> sidecar :8300 (fallback: immich)
     GET /api/assets/*/{thumbnail,original,video/playback} -> sidecar :8300 (fallback: immich)
   The byte routes MUST be GET-only and fall back to Immich when the sidecar is
   unreachable, so a dead sidecar can never affect the user's own library.
   Show me the exact diff before applying it.

VERIFY (all three, report results):
1. GET <immich-address>/immich-shared-albums/health returns {"ok":true,...}
   (use whatever address serves my Immich — LAN is fine; nothing needs to be public).
2. Any Immich share link opened in a browser shows the "Join shared album with
   your server?" card, with the album visible behind it.
3. <immich-address>/immich-shared-albums/ (signed in as an Immich admin) shows
   the panel with a "Create pairing link" button.

ROLLBACK (if anything fails): docker compose down the sidecar, revert the proxy
diff, reload the proxy — Immich itself is untouched throughout.

AFTER INSTALL:
1. If my Immich is reachable from the public internet, set
   REQUIRE_SHARE_PASSWORD=true in the sidecar env and tell me what it changes;
   then read deploy/exposure.md and offer me its posture-C hardening (access
   log, rate limiting, security headers) as a diff I can approve. Do not apply
   anything without showing me first. If nothing of mine is public, say so and
   skip this.

Notes for you, the agent:
- The sidecar is additive and fail-open: if it dies, only the share-page join card and
  cross-server sync stop; Immich keeps working. Never modify Immich's own
  compose services, database, or upload folders.
- State lives in the ./data volume (state.db: household keypair, peers, album
  mappings, ledgers). Losing it breaks existing cross-server links.
- The API key is a live credential: keep it out of shell history, logs, and
  world-readable files.
- The three routes only need to be reachable by this household's own devices; exposing
  them publicly is optional (it enables join-able share links). Either way they are safe —
  the sidecar authenticates
  human routes against the user's own Immich session and peer routes by
  mutually authenticated iroh connections plus an entitlement check (no peer routes exist over HTTP). Do NOT add source-IP restrictions to /immich-shared-albums/*:
  it would break joining from mobile data, because someone's accept page calls
  their own server's /immich-shared-albums/join.
```

---

## What a successful install looks like

- One new container (`immich-shared-albums`) on your Immich docker network.
- `https://your-domain/immich-shared-albums/` shows the sidecar panel.
- Share links show the join banner; everything else about Immich is unchanged.
