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
IMMICH_UPSTREAM_HOST=$(echo "$IMMICH_URL" | sed 's|https\?://||')
HOUSEHOLD_NAME=$(ask "Household name shown to peers [My household]:" "My household")
HOST_PORT=$(ask "Host port to expose the sidecar on (your reverse proxy points here) [8300]:" 8300)
echo "API key: create it in Immich web -> Account Settings -> API Keys -> New API Key,"
echo "ticking the permissions listed in deploy/api-key.md (the addon verifies at startup"
echo "and logs anything missing; 'all' also works but is broader than needed)."
printf 'Immich admin API key (input hidden): '
read -rs SIDECAR_API_KEY; echo
[ -n "$SIDECAR_API_KEY" ] || { echo "API key is required"; exit 1; }

echo "How should your Immich apps reach the addon?"
echo "  1) I already run a reverse proxy (Caddy/nginx/Traefik/NPM) — print the routes for me to add"
echo "  2) No proxy — the addon itself becomes the front; I'll point my apps at its port"
echo "  3) Set up a new Caddy container for me, fronting everything"
PROXY_MODE=$(ask "Pick 1, 2 or 3 [2]:" "2")
case "$PROXY_MODE" in 1|2|3) ;; *) PROXY_MODE=2;; esac
if [ "$PROXY_MODE" = "3" ]; then
  CADDY_SITE=$(ask "Domain for HTTPS (blank = plain HTTP on a port, fine for LAN):" "")
  if [ -n "$CADDY_SITE" ]; then CADDY_PORTS="80:80
      - 443:443"; else
    CADDY_HTTP_PORT=$(ask "Host port for Caddy [8080]:" 8080)
    CADDY_PORTS="$CADDY_HTTP_PORT:80"
  fi
fi

WANT_IPP=$(ask "Also set up public view-only share links via immich-public-proxy? [y/N]:" "n")
case "$WANT_IPP" in y|Y|yes|YES) WANT_IPP=1;; *) WANT_IPP="";; esac
[ -n "$WANT_IPP" ] && IPP_PORT=$(ask "Host port for immich-public-proxy [3000]:" 3000)

INSTALL_DIR=$(ask "Install directory [./immich-shared-albums-live]:" ./immich-shared-albums-live)
mkdir -p "$INSTALL_DIR/data"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"

say "Building image from source"
docker build -q -t immich-shared-albums:live "$REPO_DIR"

say "Writing $INSTALL_DIR/docker-compose.yml"
cat > "$INSTALL_DIR/docker-compose.yml" <<EOF
name: immich-shared-albums
services:
  immich-shared-albums:
    image: immich-shared-albums:live
    restart: unless-stopped
    environment:
      IMMICH_URL: $IMMICH_URL
      IMMICH_API_KEY: \${SIDECAR_API_KEY}
      HOUSEHOLD_NAME: "$HOUSEHOLD_NAME"
    volumes:
      - ./data:/data
    ports:
      - $HOST_PORT:8300
    networks: [immich]
EOF
if [ "$PROXY_MODE" = "3" ]; then
cat > "$INSTALL_DIR/Caddyfile" <<EOF
${CADDY_SITE:-:80} {
	# single front: the addon passes everything that isn't shared-album traffic to Immich,
	# and Immich is the fallback so a dead addon fails open
	reverse_proxy immich-shared-albums:8300 $IMMICH_UPSTREAM_HOST {
		lb_policy first
		fail_duration 10s
	}
}
EOF
cat >> "$INSTALL_DIR/docker-compose.yml" <<EOF
  caddy:
    image: caddy:2
    restart: unless-stopped
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    ports:
      - $CADDY_PORTS
    networks: [immich]
EOF
NEED_CADDY_VOLUME=1
fi
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
EOF
if [ -n "${NEED_CADDY_VOLUME:-}" ]; then
cat >> "$INSTALL_DIR/docker-compose.yml" <<EOF
volumes:
  caddy-data:
EOF
fi
# key lives in an env file next to the compose, chmod 600, never in the yml
umask 177
echo "SIDECAR_API_KEY=$SIDECAR_API_KEY" > "$INSTALL_DIR/.env"
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

if [ "$PROXY_MODE" = "2" ]; then
say "Done — the addon IS your front"
cat <<EOF
Point your Immich apps and browser at:  http://<this-host>:$HOST_PORT
Everything that isn't shared-album traffic passes straight through to Immich,
websockets included, and if the addon is ever down you can point apps back at
Immich directly — your library is never behind it hostage.

Verify the panel (signed in to Immich as an admin):
  http://<this-host>:$HOST_PORT/immich-shared-albums/

To uninstall: cd $INSTALL_DIR && docker compose down.
EOF
elif [ "$PROXY_MODE" = "3" ]; then
say "Done — Caddy is fronting everything"
cat <<EOF
Point your Immich apps and browser at:  ${CADDY_SITE:-http://<this-host>:${CADDY_HTTP_PORT:-8080}}
(Caddy -> addon -> Immich, with Immich as fallback so a dead addon fails open.
If you gave a domain, Caddy fetches its own HTTPS certificate — make sure the
domain's DNS points here and ports 80/443 reach this machine.)

Verify the panel (signed in to Immich as an admin):
  ${CADDY_SITE:-http://<this-host>:${CADDY_HTTP_PORT:-8080}}/immich-shared-albums/

To uninstall: cd $INSTALL_DIR && docker compose down.
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

  1. Put your public HTTPS in front of it — and ONLY it, if you're keeping Immich private:
       share.example.com { reverse_proxy immich-public-proxy:$IPP_PORT }
  2. In Immich: Administration -> Settings -> Server -> External domain
     -> set it to that public address, so the share links Immich creates point at the proxy.

Optional but recommended with this setup: in the addon's panel, switch
"Allow other Immich users to join albums via shared links" OFF — links stay
view-only, and other servers link to yours by pairing code alone.
EOF
fi
