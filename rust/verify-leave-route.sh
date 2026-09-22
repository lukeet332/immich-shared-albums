#!/usr/bin/env bash
# verify-leave-route.sh — the `POST /leave` HTTP route, over real HTTP, against live Immich.
#
#   bash rust/verify-leave-route.sh
#
# The engine (`leave_album`) already has its own proof in verify-leave.sh; what is checked HERE is
# that the route reaches it, and that the gate in front of it holds. The gate is the part worth
# proving: this route deletes other accounts' assets, so a caller who is not an admin must not reach
# it, and "not signed in" must be distinguishable from "signed in without the right".
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=9415
P2P=9416
DATA=/tmp/isa-leave-route
# The rig's host port map (PORT_IMMICH_B), defaulting to the compose default of 2284.
IMG="http://localhost:${PORT_IMMICH_B:-2284}"
RIG_ENV=demo/.env
BKEY=$(grep -m1 '^B_API_KEY=' "$RIG_ENV" | cut -d= -f2-)
[ -n "$BKEY" ] || { echo "no B_API_KEY in $RIG_ENV"; exit 1; }

export PATH=/usr/local/cargo/bin:$PATH
export RUSTUP_HOME=/usr/local/rustup CARGO_HOME="$PWD/rust/.cargo-home"

cleanup() { pkill -x isa 2>/dev/null || true; }
trap cleanup EXIT
cleanup

cd rust
# A fresh data dir every run: the seeder provisions a stand-in, and `contributors.userId` is UNIQUE,
# so a reused directory fails on the second run and `set -e` reports it as a bare non-zero exit.
rm -rf "$DATA"
ISA_IMMICH_API_KEY="$BKEY" ISA_IMMICH_URL="$IMG" ISA_DATA_DIR="$DATA" ISA_HOUSEHOLD_NAME="Leave route" \
  ISA_PORT=$PORT ISA_P2P_PORT=$P2P ISA_RELAY=off ISA_TEST_HOOKS=true \
  timeout 300 ./target/debug/examples/seed_proxy origin-asset-9 >/dev/null 2>&1
ISA_IMMICH_API_KEY="$BKEY" ISA_IMMICH_URL="$IMG" ISA_DATA_DIR="$DATA" ISA_HOUSEHOLD_NAME="Leave route" \
  ISA_PORT=$PORT ISA_P2P_PORT=$P2P ISA_RELAY=off \
  ./target/debug/isa > /tmp/isa-leave-route.log 2>&1 &
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/immich-shared-albums/health" >/dev/null 2>&1 && break; sleep 1; done

fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 — $2"; else echo "  FAIL $1 — got $2, expected $3"; fails=$((fails+1)); fi; }
post() { curl -s -o /tmp/lr-body -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/immich-shared-albums/leave" "$@" -H 'Content-Type: application/json'; }
URL="http://127.0.0.1:$PORT/immich-shared-albums/leave"

# A session that is real but NOT an admin: created here, never reused, deleted with the rig.
NONADMIN="leave-route-$RANDOM@e2e.local"
curl -s -X POST "$IMG/api/admin/users" -H "x-api-key: $BKEY" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NONADMIN\",\"password\":\"leave-route-pass-1\",\"name\":\"Leave Route Nonadmin\"}" >/dev/null
TOKEN=$(curl -s -X POST "$IMG/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NONADMIN\",\"password\":\"leave-route-pass-1\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))')
[ -n "$TOKEN" ] || { echo "could not sign in the non-admin — cannot prove the 403"; exit 1; }

code=$(post -d '{"mappingId":"m-intercept"}')
check "no session at all is refused" "$code" "401"

code=$(post -H "Authorization: Bearer $TOKEN" -d '{"mappingId":"m-intercept"}')
check "a signed-in NON-admin is refused" "$code" "403"

code=$(post -H "x-api-key: $BKEY" -d '{"mappingId":"nope"}')
check "an admin asking for an unknown mapping is a 400" "$code" "400"

code=$(post -H "x-api-key: $BKEY" -d '{}')
check "a missing mappingId is a 400, not a crash" "$code" "400"

code=$(post -H "x-api-key: $BKEY" -d '{"mappingId":"m-intercept"}')
check "an admin leaves the album" "$code" "200"
# The engine's own accounting has to survive the trip through the route: a route that answered 200
# while purging nothing would look identical from the status line alone.
grep -q '"purged":1' /tmp/lr-body || { echo "  FAIL the stub was not purged — $(cat /tmp/lr-body)"; fails=$((fails+1)); }
grep -q '"refused":0' /tmp/lr-body || { echo "  FAIL a purge was refused — $(cat /tmp/lr-body)"; fails=$((fails+1)); }
grep -q '"failed":0' /tmp/lr-body || { echo "  FAIL a purge failed — $(cat /tmp/lr-body)"; fails=$((fails+1)); }
echo "  ok   the response carries the engine's accounting — $(cat /tmp/lr-body)"

# Leaving twice is the honest 400 the engine gives, not a 500 or a silent success.
code=$(post -H "x-api-key: $BKEY" -d '{"mappingId":"m-intercept"}')
check "leaving again is refused cleanly" "$code" "400"

[ "$fails" = "0" ] && echo "PASS — /leave reaches the engine and the gate holds" || { echo "$fails check(s) failed"; exit 1; }
