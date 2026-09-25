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
DIR_B=${HAND_DIR_B:-/tmp/isa-hand-b}
DIR_C=${HAND_DIR_C:-/tmp/isa-hand-c}
PROJECT_B=${HAND_PROJECT_B:-isa-hand-b}
PROJECT_C=${HAND_PROJECT_C:-isa-hand-c}
DOCKERFILE=${ISA_DOCKERFILE:-rust/Dockerfile}

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
  # The published port is re-bound to loopback because this host also runs a real Immich: the mocks
  # carry a known admin password and install.sh correctly assumes a host of its own.
  sed -i "s|^\( *\)- ${port}:8300$|\1- 127.0.0.1:${port}:8300|" "$dir/docker-compose.yml"
  grep -q "127.0.0.1:${port}:8300" "$dir/docker-compose.yml" || fail "could not bind $label to loopback"
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

say "4/4 seeding the two linked households"
source /home/luke/rig.env 2>/dev/null || true
ISA_HAND_TEST_HOST=localhost \
PORT_IMMICH_B=${PORT_IMMICH_B:-2384} PORT_IMMICH_C=${PORT_IMMICH_C:-2385} \
PORT_SIDECAR_B="$PORT_B" PORT_SIDECAR_C="$PORT_C" \
BKEY="$BKEY" CKEY="$CKEY" \
node demo/hand-test-seed.mjs

say "installed servers"
for pair in "B:$PORT_B:$DIR_B:$PROJECT_B" "C:$PORT_C:$DIR_C:$PROJECT_C"; do
  label=${pair%%:*}; rest=${pair#*:}; port=${rest%%:*}; rest=${rest#*:}; dir=${rest%%:*}; project=${rest##*:}
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/immich-shared-albums/admin")
  echo "  $label  http://localhost:$port/immich-shared-albums/   (admin panel when signed out: $code)"
done
echo
echo "To remove them: docker compose -p $PROJECT_B down -v && docker compose -p $PROJECT_C down -v"
echo "To put the rig's own sidecars back: bash demo/run-mock-e2e.sh"
