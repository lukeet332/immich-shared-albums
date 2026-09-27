#!/usr/bin/env bash
# verify-relay-off.sh — ISA_RELAY=false end to end, on the dummy servers.
#
#   bash verify/verify-relay-off.sh
#
# Needs: the rig's B and D households up (their composes, or bash demo/run-mock-e2e.sh), the
# built sidecar image, and python3. This is the validation issue #110 asks for: with the relay
# off, a pairing ticket carries only addresses the far side can actually dial — the declared one
# first — and a peer behind its own network redeems through it. The A/B is the point: same
# binary, one setting apart.
#
# The two sidecars run on SEPARATE compose networks (B's and D's), so the joiner cannot reach the
# origin's container IP at all. That isolation is what makes "without the declared address it
# times out" a real assertion: two processes on ONE host could always reach each other's LAN IPs,
# which is why this drives containers and not the ./target binaries the other verify scripts run.
set -uo pipefail
cd "$(dirname "$0")/.."

ORIGIN=verify-relay-off-origin
JOINER=verify-relay-off-joiner
ORIGIN_HTTP=9470; ORIGIN_P2P=9471
JOINER_HTTP=9472
IMG=http://localhost:${PORT_IMMICH_B:-2284}

DKEY=$(grep -m1 '^D_SIDECAR_API_KEY=' demo/household-d/.env | cut -d= -f2-)
[ -n "$DKEY" ] || DKEY=$(grep -m1 '^D_API_KEY=' demo/household-d/.env | cut -d= -f2-)
BKEY=$(grep -m1 '^B_SIDECAR_API_KEY=' demo/.env | cut -d= -f2-)
[ -n "$BKEY" ] || BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)
[ -n "$DKEY" ] && [ -n "$BKEY" ] || { echo "no sidecar API keys in demo/.env — bring the rig up first"; exit 1; }
docker image inspect immich-shared-albums:demo >/dev/null 2>&1 \
  || { echo "no immich-shared-albums:demo image — build it (docker build -t immich-shared-albums:demo .)"; exit 1; }

fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 — $2"; else echo "  FAIL $1 — got $2, expected $3"; fails=$((fails+1)); fi; }
contains() { if printf '%s' "$2" | grep -q "$3"; then echo "  ok   $1"; else echo "  FAIL $1 — $2"; fails=$((fails+1)); fi; }

cleanup() { docker rm -f "$ORIGIN" "$JOINER" >/dev/null 2>&1; docker volume rm -f verify-relay-off-origin verify-relay-off-joiner >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

wait_health() { for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$1/immich-shared-albums/health" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "a sidecar never came up"; exit 1; }

start_joiner() {
  docker run -d --name "$JOINER" --network household-b_default --user 0:0 \
    -v verify-relay-off-joiner:/data \
    -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="$BKEY" \
    -e ISA_HOUSEHOLD_NAME="Relay-off joiner" -e ISA_RELAY=off \
    -p 127.0.0.1:$JOINER_HTTP:8300 immich-shared-albums:demo >/dev/null
  wait_health "$JOINER_HTTP"
}

# The address the JOINER can dial for the origin's published port: its own default gateway, the
# spot on the host where a published port answers. This stands in for the home router's forward.
joiner_gateway() {
  docker exec "$JOINER" sh -c 'cat /proc/net/route' | awk '$2=="00000000"{print $3; exit}' \
    | python3 -c 'import sys; h=sys.stdin.read().strip(); print(".".join(str(int(h[i:i+2],16)) for i in (6,4,2,0)))'
}

start_origin() { # start_origin <advertise-or-empty>
  local extra=(); [ -n "$1" ] && extra=(-e "ISA_ADVERTISE_ADDR=$1")
  docker run -d --name "$ORIGIN" --network household-d_default --user 0:0 \
    -v verify-relay-off-origin:/data \
    -e ISA_IMMICH_URL=http://immich-d:2283 -e ISA_IMMICH_API_KEY="$DKEY" \
    -e ISA_HOUSEHOLD_NAME="Relay-off origin" -e ISA_RELAY=off "${extra[@]}" \
    -p 127.0.0.1:$ORIGIN_HTTP:8300 -p 0.0.0.0:$ORIGIN_P2P:8300/udp \
    immich-shared-albums:demo >/dev/null
  wait_health "$ORIGIN_HTTP"
}

mint() { curl -s -X POST "http://127.0.0.1:$ORIGIN_HTTP/immich-shared-albums/pairings" -H "x-api-key: $DKEY"; }
redeem() { curl -s -m 60 -X POST "http://127.0.0.1:$JOINER_HTTP/immich-shared-albums/pair" \
  -H 'Content-Type: application/json' -H "x-api-key: $BKEY" -d "{\"link\":\"$1\"}"; }
link_of() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("link",""))'; }
ticket_json() { printf '%s' "$1" | python3 -c '
import json,sys,base64
link = sys.stdin.read().strip()
body = link[len("isa2-"):] if link.startswith("isa2-") else link
t = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
print(json.dumps({"relay": t.get("relay"), "addrs": t.get("addrs", [])}))'; }

echo "== POSITIVE: the origin declares the address the joiner answers =="
start_joiner
GW=$(joiner_gateway)
[ -n "$GW" ] || { echo "could not read the joiner's gateway"; exit 1; }
start_origin "$GW:$ORIGIN_P2P"
echo "origin advertises $GW:$ORIGIN_P2P (the joiner's gateway)"
LINK=$(link_of "$(mint)")
[ -n "$LINK" ] || { echo "minting failed"; exit 1; }
ADDRS=$(ticket_json "$LINK")
echo "ticket: $ADDRS"
check "the ticket leads with the declared address" \
  "$(printf '%s' "$ADDRS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["addrs"][0])')" "$GW:$ORIGIN_P2P"
check "and the ticket carries no relay (the point of running without one)" \
  "$(printf '%s' "$ADDRS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["relay"])')" "None"

OUT=$(redeem "$LINK")
contains 'the joiner behind its own network redeems through the declared address' "$OUT" '"linked"'
PEERS=$(curl -s -H "x-api-key: $DKEY" "http://127.0.0.1:$ORIGIN_HTTP/immich-shared-albums/peers")
contains 'and the origin enrolled it' "$PEERS" 'Relay-off joiner'

echo
echo "== NEGATIVE: same origin shape, no declared address =="
docker rm -f "$ORIGIN" >/dev/null 2>&1 && docker volume rm -f verify-relay-off-origin >/dev/null 2>&1
start_origin ""
LINK=$(link_of "$(mint)")
ADDRS=$(ticket_json "$LINK")
echo "ticket: $ADDRS"
check 'the ticket carries no address that answers on the forwarded port' \
  "$(printf '%s' "$ADDRS" | python3 -c 'import json,sys;a=json.load(sys.stdin)["addrs"];print("no" if any(x.endswith(":9471") for x in a) else "yes")')" "yes"
OUT=$(redeem "$LINK")
contains 'the redeem times out rather than finding a path that does not exist' "$OUT" 'timed out'

echo
if [ "$fails" -eq 0 ]; then echo "✅ ALL PASS"; else echo "❌ $fails FAILURES"; fi
exit "$fails"
