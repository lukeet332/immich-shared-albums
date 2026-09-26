#!/usr/bin/env bash
# hand-test-up.sh — a two-household rig you can sign into and click, with the sidecars INSTALLED by
# `deploy/install.sh` rather than the rig's own compose services.
#
#   bash demo/hand-test-up.sh          # B on :9301, C on :9302
#
# Why the installer instead of the rig's sidecars: install.sh is the thing an operator runs, and a
# rig built any other way tests everything except the path that actually ships. This drives the real
# prompts, the real build, the real `docker compose up` and the real health check, twice.
#
# The rig's own sidecars are STOPPED first (two sidecars on one Immich fight over the same bot
# account), and the two mocks are purged, so what it leaves is two clean households.
#
# Everything it creates is disposable: /tmp/isa-hand-b, /tmp/isa-hand-c and the two compose projects.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT_B=${HAND_PORT_B:-9301}
PORT_C=${HAND_PORT_C:-9302}
# The rig has three households and the mesh needs all of them linked, so D is installed too.
PORT_D=${HAND_PORT_D:-9303}
# Where the two servers are published. Loopback by default, because the mocks carry a known admin
# password; `HAND_BIND=100.x.y.z` — this host's Tailscale address — is what you use to click them from
# another device, and it is deliberately narrower than 0.0.0.0 so the LAN never sees them.
BIND=${HAND_BIND:-127.0.0.1}
DIR_B=${HAND_DIR_B:-/tmp/isa-hand-b}
DIR_C=${HAND_DIR_C:-/tmp/isa-hand-c}
DIR_D=${HAND_DIR_D:-/tmp/isa-hand-d}
PROJECT_B=${HAND_PROJECT_B:-isa-hand-b}
PROJECT_C=${HAND_PROJECT_C:-isa-hand-c}
PROJECT_D=${HAND_PROJECT_D:-isa-hand-d}
DOCKERFILE=${ISA_DOCKERFILE:-Dockerfile}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

[ -f demo/.env ] || fail "no demo/.env — run demo/run-mock-e2e.sh once first"
[ -f demo/household-c/.env ] || fail "no demo/household-c/.env — run demo/run-mock-e2e.sh once first"
BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)
CKEY=$(grep -m1 '^C_API_KEY=' demo/household-c/.env | cut -d= -f2-)
[ -n "$BKEY" ] && [ -n "$CKEY" ] || fail "no admin keys in demo/.env / demo/household-c/.env"

say "1/4 mock Immichs up, rig sidecars stopped"
# SKIP_BUILD: this script builds the image itself, through install.sh, which is the point.
SKIP_BUILD=1 RIG_MOCKS_ONLY=1 ISA_DOCKERFILE="$DOCKERFILE" bash demo/run-mock-e2e.sh

install_one() { # install_one <label> <network> <immich url> <household> <port> <key> <dir> <project>
  local label=$1 net=$2 url=$3 household=$4 port=$5 key=$6 dir=$7 project=$8
  say "installing $label through deploy/install.sh (port $port)"
  # A previous run's identity volume would keep a stale pairing: this is the reset, not `down`.
  ( cd "$dir" 2>/dev/null && docker compose -p "$project" down -v >/dev/null 2>&1 ) || true
  rm -rf "$dir"
  # The prompts, in order: network, immich url, household name, host port, API key, reverse proxy,
  # public-proxy, install dir. Answering them IS the test.
  local answers
  answers=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$net" "$url" "$household" "$port" "$key" "n" "n" "$dir")
  if ! printf '%s\n' "$answers" | COMPOSE_PROJECT_NAME="$project" ISA_DOCKERFILE="$DOCKERFILE" \
       bash deploy/install.sh > "/tmp/isa-hand-install-$label.log" 2>&1; then
    tail -25 "/tmp/isa-hand-install-$label.log" >&2
    fail "install.sh failed for $label (log: /tmp/isa-hand-install-$label.log)"
  fi
  grep -q "health: OK" "/tmp/isa-hand-install-$label.log" || {
    tail -25 "/tmp/isa-hand-install-$label.log" >&2; fail "install.sh did not report $label healthy"; }
  echo "  install.sh reported health OK"

  # install.sh writes the whole project name into the compose file, so a SECOND install on one host
  # would take over the first project's containers. COMPOSE_PROJECT_NAME above is what separates
  # them, and it is passed again here so the reconcile below lands on the same project.
  # The published port is re-bound to $BIND because this host also runs a real Immich: the mocks carry
  # a known admin password and install.sh correctly assumes a host of its own. `up -d` keeps the
  # identity volume, so re-running this against a live rig re-binds it without breaking a pairing.
  # Both mappings when the bind is not loopback: this script drives the sidecar on 127.0.0.1 (a port
  # bound to one host address is NOT on loopback), while the tester's device uses $BIND.
  if [ "$BIND" = "127.0.0.1" ]; then
    sed -i "s|^\( *\)- ${port}:8300$|\1- 127.0.0.1:${port}:8300|" "$dir/docker-compose.yml"
  else
    sed -i "s|^\( *\)- ${port}:8300$|\1- 127.0.0.1:${port}:8300\n\1- ${BIND}:${port}:8300|" "$dir/docker-compose.yml"
  fi
  grep -q "127.0.0.1:${port}:8300" "$dir/docker-compose.yml" || fail "could not bind $label to loopback"
  grep -q "${BIND}:${port}:8300" "$dir/docker-compose.yml" || fail "could not bind $label to $BIND"
  ( cd "$dir" && docker compose -p "$project" up -d >/dev/null )
  local cid
  cid=$(cd "$dir" && docker compose -p "$project" ps -q immich-shared-albums)
  [ -n "$cid" ] || fail "$label has no running container"
  # The installer attaches the sidecar to ONE network — Immich's, which is all an operator needs.
  # Peers reach each other over the internet in the field; in the rig that is the shared isa-demo
  # network, so the two installed sidecars can dial each other directly instead of via the relay.
  docker network connect isa-demo "$cid" 2>/dev/null || true
  echo "  $label container $cid on $net + isa-demo"
}

install_one B household-b_default "http://immich-b:2283" "Demo household (B)" "$PORT_B" "$BKEY" "$DIR_B" "$PROJECT_B"
install_one C household-c_default "http://immich-c:2283" "Mock household (C)" "$PORT_C" "$CKEY" "$DIR_C" "$PROJECT_C"
DKEY=$(grep -m1 '^D_API_KEY=' demo/household-d/.env | cut -d= -f2-)
install_one D household-d_default "http://immich-d:2283" "Mock household (D)" "$PORT_D" "$DKEY" "$DIR_D" "$PROJECT_D"

say "4/4 seeding the two linked households"
source /home/luke/rig.env 2>/dev/null || true
# The address a PERSON types, which is not the same as the address the seed talks to: the seed drives
# the mocks on loopback, but the URLs it prints have to be openable from the tester's device. With
# `HAND_BIND=0.0.0.0` the bind itself names nothing, so ask the host's tailnet for its address.
HAND_HOST=$BIND
if [ "$BIND" = "0.0.0.0" ]; then
  HAND_HOST=$(docker run --rm --network host alpine:3.22 sh -c \
    "ip -4 -o addr show tailscale0 2>/dev/null | awk '{print \$4}'" 2>/dev/null | cut -d/ -f1 | head -1)
  [ -n "$HAND_HOST" ] || HAND_HOST=localhost
fi
ISA_HAND_TEST_HOST="$HAND_HOST" ISA_HAND_DRIVE_HOST=localhost \
PORT_IMMICH_B=${PORT_IMMICH_B:-2384} PORT_IMMICH_C=${PORT_IMMICH_C:-2385} \
PORT_SIDECAR_B="$PORT_B" PORT_SIDECAR_C="$PORT_C" PORT_SIDECAR_D="$PORT_D" \
BKEY="$BKEY" CKEY="$CKEY" \
node demo/hand-test-seed.mjs

say "installed servers"
for pair in "B:$PORT_B" "C:$PORT_C" "D:$PORT_D"; do
  label=${pair%%:*}; port=${pair#*:}
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://$HAND_HOST:$port/immich-shared-albums/admin")
  echo "  $label  http://$HAND_HOST:$port/immich-shared-albums/   (admin panel when signed out: $code)"
done
echo
echo "To remove them: docker compose -p $PROJECT_B down -v && docker compose -p $PROJECT_C down -v"
echo "To put the rig's own sidecars back: bash demo/run-mock-e2e.sh"
