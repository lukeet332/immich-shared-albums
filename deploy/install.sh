#!/bin/bash
# immich-shared-albums installer — adds the sidecar next to an EXISTING Immich
# docker-compose deployment. Safe by design: it only ever ADDS one container and
# prints the reverse-proxy lines for you to review; it never edits your Immich
# compose file or proxy config itself.
#
# Run from a clone of the repo:   git clone https://github.com/lukeet332/immich-shared-albums
#                                 cd immich-shared-albums && bash deploy/install.sh
set -euo pipefail

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { local v; read -r -p "$1 " v; echo "${v:-$2}"; }

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
command -v docker >/dev/null || { echo "docker is required — install Docker first"; exit 1; }

say "immich-shared-albums installer"
echo "You'll need an Immich admin API key — see deploy/api-key.md for the exact"
echo "permissions to tick (a short list; 'all' also works but is broader than needed)."

# auto-detect the network the Immich server container is on, to pre-fill the prompt
DEFAULT_NET=immich_default
IMMICH_CTR=$(docker ps --format '{{.Names}} {{.Image}}' | grep -iE 'immich[-_]server|immich-app/immich' | head -1 | cut -d' ' -f1)
if [ -n "$IMMICH_CTR" ]; then
  DETECTED=$(docker inspect "$IMMICH_CTR" -f '{{range $n,$_ := .NetworkSettings.Networks}}{{$n}}{{"\n"}}{{end}}' 2>/dev/null | head -1)
  [ -n "$DETECTED" ] && { DEFAULT_NET="$DETECTED"; echo "Found Immich container '$IMMICH_CTR' on network '$DEFAULT_NET'."; }
fi
IMMICH_NETWORK=$(ask "Docker network your Immich containers are on [$DEFAULT_NET]:" "$DEFAULT_NET")
docker network inspect "$IMMICH_NETWORK" >/dev/null 2>&1 || {
  echo "network '$IMMICH_NETWORK' not found. Existing networks:"; docker network ls --format '  {{.Name}}'; exit 1; }

IMMICH_URL=$(ask "Immich server URL as reachable from that network [http://immich-server:2283]:" http://immich-server:2283)
HOUSEHOLD_NAME=$(ask "Household name shown to peers [My household]:" "My household")
HOST_PORT=$(ask "Host port to expose the sidecar on (your apps or proxy will point here) [8300]:" 8300)
echo "API key: create it in Immich web -> Account Settings -> API Keys -> New API Key,"
echo "ticking the permissions listed in deploy/api-key.md (the addon verifies at startup"
echo "and logs anything missing; 'all' also works but is broader than needed)."
printf 'Immich admin API key (input hidden): '
read -rs ISA_API_KEY; echo
[ -n "$ISA_API_KEY" ] || { echo "API key is required"; exit 1; }

# No proxy is the default and needs nothing extra: the addon itself is the front,
# passing everything that isn't shared-album traffic through to Immich.
HAVE_PROXY=$(ask "Do you already run a reverse proxy in front of Immich (Caddy/nginx/Traefik/NPM)? [y/N]:" "n")
case "$HAVE_PROXY" in y|Y|yes|YES) PROXY_MODE=1;; *) PROXY_MODE=2;; esac

WANT_IPP=$(ask "Also set up public view-only share links via immich-public-proxy? [y/N]:" "n")
case "$WANT_IPP" in y|Y|yes|YES) WANT_IPP=1;; *) WANT_IPP="";; esac
[ -n "$WANT_IPP" ] && IPP_PORT=$(ask "Host port for immich-public-proxy [3000]:" 3000)

INSTALL_DIR=$(ask "Install directory [./immich-shared-albums-live]:" ./immich-shared-albums-live)
mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"

# The compose project name IS the volume's name (<project>_isa-data). Two sidecar installs on one
# host must therefore differ, or `down -v` on one destroys the other's identity — which is the
# household's keypair, and losing it orphans every pairing.
COMPOSE_PROJECT=$(ask "Compose project name (the state volume is named after it) [immich-shared-albums]:" "immich-shared-albums")

# The sidecar image builds from the repo root.
DOCKERFILE="${ISA_DOCKERFILE:-Dockerfile}"
[ -f "$REPO_DIR/$DOCKERFILE" ] || { echo "no $DOCKERFILE in $REPO_DIR"; exit 1; }
say "Building image from source ($DOCKERFILE)"
docker build -q -t immich-shared-albums:live -f "$REPO_DIR/$DOCKERFILE" "$REPO_DIR"

say "Writing $INSTALL_DIR/docker-compose.yml"
cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
name: $COMPOSE_PROJECT
services:
  immich-shared-albums:
    image: immich-shared-albums:live
    restart: unless-stopped
    environment:
      ISA_IMMICH_URL: $IMMICH_URL
      ISA_IMMICH_API_KEY: \${ISA_IMMICH_API_KEY}
      ISA_HOUSEHOLD_NAME: "$HOUSEHOLD_NAME"
    volumes:
      # a named volume, so the container's own (non-root) user owns it. The identity key
      # lives here: docker compose down -v would delete it and orphan every pairing.
      - isa-data:/data
    ports:
      - $HOST_PORT:8300
      # Server-to-server traffic uses UDP 8300 (ISA_P2P_PORT). It works without publishing this;
      # uncomment (and forward it on your router) only for a guaranteed direct path between servers.
      # - 8300:8300/udp
    networks: [immich]
EOF
if [ -n "$WANT_IPP" ]; then
cat >> "$INSTALL_DIR/docker-compose.yml" <<EOF
  immich-public-proxy:
    image: alangrainger/immich-public-proxy:latest
    restart: unless-stopped
    environment:
      # points at the ADDON, so photos shared from other servers render full quality in links
      IMMICH_URL: http://immich-shared-albums:8300
    ports:
      - $IPP_PORT:3000
    networks: [immich]
EOF
fi
cat >> "$INSTALL_DIR/docker-compose.yml" <<EOF
networks:
  immich:
    external: true
    name: $IMMICH_NETWORK
volumes:
  isa-data:
EOF
# key lives in an env file next to the compose, chmod 600, never in the yml
umask 177
echo "ISA_IMMICH_API_KEY=$ISA_API_KEY" > "$INSTALL_DIR/.env"
umask 022

say "Starting sidecar"
(cd "$INSTALL_DIR" && docker compose up -d)
printf "waiting for health"
ok=""
for _ in $(seq 1 20); do
  if (cd "$INSTALL_DIR" && docker compose exec -T immich-shared-albums wget -qO- http://localhost:8300/immich-shared-albums/health 2>/dev/null) | grep -q '"ok":true'; then
    ok=1; break
  fi
  printf "."; sleep 1
done
echo
if [ -n "$ok" ]; then
  echo "health: OK"
else
  echo "health check failed — logs:"; (cd "$INSTALL_DIR" && docker compose logs immich-shared-albums --tail 30); exit 1
fi

# Health is unconditional (the sidecar fails open), so a wrong URL or a key Immich rejects would
# otherwise read as a successful install and surface days later as an empty panel. Ask the sidecar
# to exercise the exact path it will use forever: container -> Immich, with this key.
say "Verifying Immich is reachable with this key"
if (cd "$INSTALL_DIR" && docker compose exec -T immich-shared-albums \
      wget -qO- --header="x-api-key: $ISA_API_KEY" "$IMMICH_URL/api/users/me" 2>/dev/null) | grep -q '"id"'; then
  echo "key verified against $IMMICH_URL"
else
  echo "FAIL: the sidecar cannot use this key against $IMMICH_URL."
  echo "  - check the URL is Immich's address as reachable from the docker network you named, and"
  echo "  - check the key against deploy/api-key.md (created on an ADMIN account)."
  echo "  Immich itself is untouched; fix and re-run this installer — it is safe to re-run."
  (cd "$INSTALL_DIR" && docker compose logs immich-shared-albums --tail 20)
  exit 1
fi

if [ "$PROXY_MODE" = "2" ]; then
say "Done — the addon IS your front"
cat <<EOF
Point your Immich apps and browser at:  http://<this-host>:$HOST_PORT
Everything that isn't shared-album traffic passes straight through to Immich,
websockets included, and if the addon is ever down you can point apps back at
Immich directly — your library is never behind it hostage.

Verify the panel (signed in to Immich as an admin):
  http://<this-host>:$HOST_PORT/immich-shared-albums/

To uninstall: cd $INSTALL_DIR && docker compose down (add -v to also delete\nthis server's identity — other servers would need a fresh pairing link).
EOF
else
say "Last step (manual): route three paths through your reverse proxy"
cat <<EOF
Add to your existing site config, BEFORE the catch-all Immich route:

  Caddy (byte routes are GET-only and fall back to Immich if the sidecar is down):
    handle /immich-shared-albums/* { reverse_proxy immich-shared-albums:8300 }
    handle /share/*   { reverse_proxy immich-shared-albums:8300 immich-server:2283 { lb_policy first } }
    @sharedbytes {
      method GET
      path /api/assets/*/thumbnail /api/assets/*/original /api/assets/*/video/playback
    }
    handle @sharedbytes { reverse_proxy immich-shared-albums:8300 immich-server:2283 { lb_policy first } }

  nginx:
    location /immich-shared-albums/ { proxy_pass http://127.0.0.1:$HOST_PORT; }
    location /share/   { proxy_pass http://127.0.0.1:$HOST_PORT; }
    location ~ ^/api/assets/[^/]+/(thumbnail|original|video/playback)$ {
      limit_except GET { proxy_pass http://immich-upstream; }
      proxy_pass http://127.0.0.1:$HOST_PORT;
    }

Then reload the proxy and open any Immich share link — you should see the
"Join shared album with your server?" banner. Verify the panel at:
  https://<your-immich>/immich-shared-albums/

To uninstall: cd $INSTALL_DIR && docker compose down && remove the proxy lines.
EOF
fi

if [ -n "$WANT_IPP" ]; then
cat <<EOF

immich-public-proxy is running on port $IPP_PORT. Two follow-ups it can't do for you:

  1. Make port $IPP_PORT reachable at your public address — and ONLY that port, if
     you're keeping Immich private. However you host things is up to you; the
     proxy's own docs cover the common setups:
       https://github.com/alangrainger/immich-public-proxy
  2. In Immich: Administration -> Settings -> Server -> External domain
     -> set it to that public address, so the share links Immich creates point at the proxy.

Optional but recommended with this setup: in the addon's panel, switch
"Allow other Immich users to join albums via shared links" OFF — links stay
view-only, and other servers link to yours by pairing code alone.
EOF
fi
