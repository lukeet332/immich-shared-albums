# Installing the addon

Three ways in, easiest first:

- **AI agent** — point Claude Code, Cursor or similar at [INSTALL-AI.md](./INSTALL-AI.md). It
  inspects your actual setup and adapts, including your reverse proxy config.
- **Script** — `bash deploy/install.sh` from a clone of this repo. It detects your Immich,
  asks a handful of questions and starts the addon. It can also set up
  [immich-public-proxy](https://github.com/alangrainger/immich-public-proxy) for public
  share links.
- **By hand** — the rest of this page.

Whichever route you take, the step-by-step walkthrough with screenshots-level detail is
[SETUP.md](./SETUP.md), and nothing needs to be reachable from the internet.

## Manual install

1. **Build the image** from a clone of this repo:

   ```sh
   docker build -t immich-shared-albums:live .
   ```

2. **Create the API key.** In Immich web, signed in as an admin: *Account Settings → API Keys
   → New API Key*, ticking the permissions in [api-key.md](./api-key.md) (`all` also works but
   is broader than needed). The addon verifies the key at startup and logs anything missing.

3. **Start the container** with [docker-compose.example.yml](./docker-compose.example.yml) —
   it joins your Immich docker network and holds the key in a `.env` file. Every setting is
   documented in [configuration.md](./configuration.md).

4. **Put it in front of Immich** so the stock apps see shared photos. Two shapes:

   - **Single front (simplest):** point your apps — or your reverse proxy — at the addon's
     port instead of Immich's. It passes everything that isn't shared-album traffic straight
     through, websockets included, and Immich stays reachable directly as an escape hatch.
     The Caddy version of this is in [exposure.md §2](./exposure.md).
   - **Three routes:** keep your proxy pointed at Immich and add the routes in
     [Caddyfile.snippet](./Caddyfile.snippet) (they translate 1:1 to nginx/Traefik/NPM).

5. **Verify.** In a web browser, signed in to Immich as an admin, open
   `https://<your-immich>/immich-shared-albums/` — the admin panel with *Create pairing link*
   means everything works.

Uninstalling is `docker compose down` plus removing whatever proxy lines you added — the
addon never modifies Immich itself.
