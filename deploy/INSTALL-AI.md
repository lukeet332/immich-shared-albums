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
1. My public Immich URL (e.g. https://photos.example.com).
2. A household name to show to peers (e.g. "The Smith household").
3. An Immich admin API key with ALL permissions — I create it in
   Immich web -> Account Settings -> API Keys -> New API Key -> tick everything.
   (If password login is disabled on my server because I use OAuth, warn me the
   sidecar will briefly toggle it during utility-user provisioning.)

INSTALL:
1. git clone https://github.com/lukeet332/immich-shared-albums
2. Either run `bash deploy/install.sh` interactively with me, or replicate what
   it does: build the image, write a compose file joining the sidecar to the
   Immich docker network with env IMMICH_URL, IMMICH_API_KEY (in a chmod-600
   .env file, never in the yml), PUBLIC_URL, HOUSEHOLD_NAME, and a ./data
   volume for /data. Start it with docker compose up -d.
3. Add these three routes to my reverse proxy BEFORE the catch-all Immich route,
   then reload the proxy:
     /sidecar/*                                       -> sidecar :8300
     /share/*                                         -> sidecar :8300 (fallback: immich)
     GET /api/assets/*/{thumbnail,original,video/playback} -> sidecar :8300 (fallback: immich)
   The byte routes MUST be GET-only and fall back to Immich when the sidecar is
   unreachable, so a dead sidecar can never affect the user's own library.
   Show me the exact diff before applying it.

VERIFY (all three, report results):
1. GET <public-url>/sidecar/health returns {"ok":true,...}.
2. Any Immich share link opened in a browser shows the
   "Join shared album with your server?" banner over the working share page.
3. The share page itself still fully loads (photos render behind the banner).

ROLLBACK (if anything fails): docker compose down the sidecar, revert the proxy
diff, reload the proxy — Immich itself is untouched throughout.

Notes for you, the agent:
- The sidecar is additive and fail-open: if it dies, only the banner and
  cross-server sync stop; Immich keeps working. Never modify Immich's own
  compose services, database, or upload folders.
- State lives in the ./data volume (state.json: household keypair, peers,
  album mappings). Losing it breaks existing cross-server links.
- The API key is a live credential: keep it out of shell history, logs, and
  world-readable files.
```

---

## What a successful install looks like

- One new container (`immich-shared`) on your Immich docker network.
- `https://your-domain/sidecar/` shows the sidecar panel.
- Share links show the join banner; everything else about Immich is unchanged.
