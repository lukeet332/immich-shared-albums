#!/usr/bin/env bash
# verify-panel.sh — spin up the Rust sidecar against the mock rig and load its panel in a browser.
#
#   bash verify/verify-panel.sh
#
# The sidecar is a FRONT for Immich: the browser signs in and reads the panel through ONE origin,
# which is both how a real install is reached and the only arrangement where the Immich session
# cookie applies to the panel. The container is started on household B's compose network so it can
# reach the mock Immich by name.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=isa-panel-check
PORT=8398
NET=household-b_default
RIG_ENV=demo/.env

[ -f "$RIG_ENV" ] || { echo "no $RIG_ENV — run demo/run-mock-e2e.sh first"; exit 1; }
API_KEY=$(grep -m1 '^B_API_KEY=' "$RIG_ENV" | cut -d= -f2-)
[ -n "$API_KEY" ] || { echo "no B_API_KEY in $RIG_ENV"; exit 1; }
docker network inspect "$NET" >/dev/null 2>&1 || { echo "no $NET network — is the rig up?"; exit 1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" --network "$NET" \
  -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="$API_KEY" \
  -e ISA_HOUSEHOLD_NAME="Rust check" -e ISA_SYNC_POLL_MS=1000 \
  -p "127.0.0.1:$PORT:8300" immich-shared-albums:rust >/dev/null

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/immich-shared-albums/health" >/dev/null 2>&1 && break
  sleep 1
done

# The sidecar must reach the mock Immich, or the panel renders but every card says nothing.
curl -fsS -H "x-api-key: $API_KEY" "http://127.0.0.1:$PORT/immich-shared-albums/peers" >/dev/null \
  || { echo "FAIL: the sidecar could not authenticate a caller against Immich"; docker logs "$NAME" 2>&1 | tail -20; exit 1; }

node verify/verify-panel-browser.mjs "http://127.0.0.1:$PORT"
