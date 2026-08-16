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
echo "You'll need an Immich admin API key with all permissions:"
echo "  Immich web -> Account Settings -> API Keys -> New API Key -> tick everything."

IMMICH_NETWORK=$(ask "Docker network your Immich containers are on [immich_default]:" immich_default)
docker network inspect "$IMMICH_NETWORK" >/dev/null 2>&1 || {
  echo "network '$IMMICH_NETWORK' not found. Existing networks:"; docker network ls --format '  {{.Name}}'; exit 1; }

IMMICH_URL=$(ask "Immich server URL as reachable from that network [http://immich-server:2283]:" http://immich-server:2283)
PUBLIC_URL=$(ask "Public URL of your Immich (what family types in a browser), e.g. https://photos.example.com:" "")
[ -n "$PUBLIC_URL" ] || { echo "public URL is required — peers redeem invites against it"; exit 1; }
HOUSEHOLD_NAME=$(ask "Household name shown to peers [My household]:" "My household")
HOST_PORT=$(ask "Host port to expose the sidecar on (your reverse proxy points here) [8300]:" 8300)
printf 'Immich admin API key (input hidden): '
read -rs SIDECAR_API_KEY; echo
[ -n "$SIDECAR_API_KEY" ] || { echo "API key is required"; exit 1; }

INSTALL_DIR=$(ask "Install directory [./immich-shared-albums-live]:" ./immich-shared-albums-live)
mkdir -p "$INSTALL_DIR/data"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"

say "Building image from source"
docker build -q -t immich-shared-albums:live "$REPO_DIR"

say "Writing $INSTALL_DIR/docker-compose.yml"
cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
name: immich-shared-albums
services:
  immich-shared:
    image: immich-shared-albums:live
    restart: unless-stopped
    environment:
      IMMICH_URL: $IMMICH_URL
      IMMICH_API_KEY: \${SIDECAR_API_KEY}
      PUBLIC_URL: $PUBLIC_URL
      HOUSEHOLD_NAME: "$HOUSEHOLD_NAME"
    volumes:
      - ./data:/data
    ports:
      - $HOST_PORT:8300
    networks: [immich]
networks:
  immich:
    external: true
    name: $IMMICH_NETWORK
EOF
# key lives in an env file next to the compose, chmod 600, never in the yml
umask 177
echo "SIDECAR_API_KEY=$SIDECAR_API_KEY" > "$INSTALL_DIR/.env"
umask 022

say "Starting sidecar"
(cd "$INSTALL_DIR" && docker compose up -d)
sleep 3
if docker exec immich-shared-albums-immich-shared-1 wget -qO- http://localhost:8300/sidecar/health 2>/dev/null | grep -q '"ok":true'; then
  echo "health: OK"
else
  echo "health check failed — logs:"; (cd "$INSTALL_DIR" && docker compose logs immich-shared --tail 30); exit 1
fi

say "Last step (manual): route three paths through your reverse proxy"
cat <<EOF
Add to your existing site config, BEFORE the catch-all Immich route:

  Caddy:
    handle /sidecar/*                { reverse_proxy immich-shared:8300 }
    handle /share/*                  { reverse_proxy immich-shared:8300 }
    handle /api/assets/*/original    { reverse_proxy immich-shared:8300 }

  nginx:
    location /sidecar/                     { proxy_pass http://127.0.0.1:$HOST_PORT; }
    location /share/                       { proxy_pass http://127.0.0.1:$HOST_PORT; }
    location ~ ^/api/assets/[^/]+/original { proxy_pass http://127.0.0.1:$HOST_PORT; }

Then reload the proxy and open any Immich share link — you should see the
"Join shared album with your server?" banner. Verify the panel at:
  $PUBLIC_URL/sidecar/

To uninstall: cd $INSTALL_DIR && docker compose down && remove the proxy lines.
EOF
