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
   and tell me the two follow-ups: make only the proxy's port publicly
   reachable (my choice how — its own README covers the common setups), and set
   Immich's Administration -> Settings -> Server -> External domain to that
   public address.

INSTALL:
1. git clone https://github.com/lukeet332/immich-shared-albums
2. Run `bash deploy/install.sh` interactively with me. It asks for a compose
   project name too — the state volume is named after it, so give it a distinct
   name if this host will ever run a second sidecar (default: immich-shared-albums).
   Before it reports success, the installer proves the key works: it asks the
   sidecar's own container to call Immich with it, and fails with a fix-it message
   if the URL or the key is wrong. (Replicating it by hand is possible but you
   would be re-implementing those checks: build the image, write a compose file
   joining the sidecar to the Immich docker network with env ISA_IMMICH_URL,
   ISA_IMMICH_API_KEY in a chmod-600 .env file — never in the yml —
   ISA_HOUSEHOLD_NAME, and a NAMED volume for /data.)
3. If I have NO reverse proxy, skip the routes entirely: the sidecar is itself a
   front for Immich — everything that isn't shared-album traffic passes through,
   websockets included. Just tell me to point my Immich apps and browser at the
   sidecar's port instead of Immich's.
   Otherwise, add these three routes to my reverse proxy BEFORE the catch-all
   Immich route, then reload the proxy:
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
   the panel with a "Create a link" button.

ROLLBACK (if anything fails): docker compose down the sidecar, revert the proxy
diff, reload the proxy — Immich itself is untouched throughout.

AFTER INSTALL:
1. If my Immich is reachable from the public internet, set
   ISA_LINK_JOIN_REQUIRES_PASSWORD=true in the sidecar env and tell me what it changes,
   and point me at Immich's own hardening guidance — hosting is theirs to
   document, and the sidecar adds no public surface beyond its own routes
   (deploy/exposure.md has the details). If nothing of mine is public, say so
   and skip this.

Notes for you, the agent:
- The sidecar is additive and fail-open: if it dies, only the share-page join card and
  cross-server sync stop; Immich keeps working. Never modify Immich's own
  compose services, database, or upload folders.
- State lives on the `isa-data` volume, NOT a ./data directory — it is a named volume so the
  container's own non-root user owns it (state.db: household keypair, peers, album mappings,
  ledgers). Losing it breaks existing cross-server links. Back up the volume, not a path:
  `docker run --rm -v immich-shared-albums_isa-data:/data -v "$PWD":/backup alpine tar czf /backup/isa-data.tgz -C /data .`
  (the volume name is `<compose project>_isa-data`; `docker volume ls` finds it). Copy state.db
  WITH its -wal/-shm files, which carry recent writes, and never open a running sidecar's
  state.db with a host sqlite3 on macOS — it deletes the WAL under the process. Inspect it
  through a THROWAWAY container instead — the sidecar runs as uid 1000, so `docker compose exec
  ... apk add` cannot install a client, and a second container mounting the same volume can:
  `docker run --rm -v immich-shared-albums_isa-data:/data alpine:3.22 sh -c 'apk add --no-cache sqlite >/dev/null && sqlite3 /data/state.db "select name from sqlite_master where type=\'table\';"'`.
- Server-to-server traffic uses UDP 8300 inside the container (ISA_P2P_PORT). Nothing needs
  opening for it to work; publishing `8300:8300/udp` is optional and only buys a guaranteed
  direct path.
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
