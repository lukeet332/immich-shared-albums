#!/bin/bash
# verify-nudges.sh — the A/B for issue #116's acceptance, on the dummy servers: with both
# backstops pushed out to 300s, a change made through the sidecar's own proxy still wakes the
# peer's lanes within seconds, which no timer can explain. The stillness phase proves the
# timers really are quiet before the write happens, so what follows can only be the nudge.
# The other half of the contract — a dropped nudge still converges — is pinned by the unit
# test in src/sync/wakes.rs (the timer fires with no wake at all).
# Rig-only: this script is incapable of reaching anything but its own compose networks.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
check() {
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "  ✅ $1";
  else FAIL=$((FAIL+1)); echo "  ❌ $1${3:+ — $3}"; fi
}
cleanup() { docker rm -f vn-w-fast vn-r-fast vn-w vn-r >/dev/null 2>&1; }
trap cleanup EXIT

D_NET=household-d_default
B_NET=household-b_default
SLOW=300000        # 5 minutes: no backstop sweep can fire inside the measurement window
STILL=20           # seconds of observed quiet, proving no timer is due
WINDOW=40          # seconds the nudge has to wake the receiver's lanes

WKEY=${W_API_KEY:-$(grep -m1 '^D_API_KEY=' demo/household-d/.env | cut -d= -f2-)}
RKEY=${R_API_KEY:-$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)}
[ -n "${WKEY:-}" ] && [ -n "${RKEY:-}" ] || { echo "❌ the rig's .env keys are missing — run demo/run-mock-e2e.sh first"; exit 1; }

W_PORT=9481; R_PORT=9482

echo "== verify-nudges: a channel nudge wakes the peer's lanes minutes before any backstop =="

echo "-- phase 1: pair the writer and the receiver on a fast cadence (setup, not the measurement) --"
docker run --rm -v "$(pwd)":/w alpine sh -c 'rm -rf /w/.vn-w-data /w/.vn-r-data' >/dev/null
docker run -d --name vn-w-fast --network ${D_NET} --user 0:0 -p 127.0.0.1:${W_PORT}:${W_PORT} \
  -e ISA_IMMICH_URL=http://immich-d:2283 -e ISA_IMMICH_API_KEY="${WKEY}" \
  -e ISA_HOUSEHOLD_NAME="Nudge Verify Writer" -e ISA_PORT=${W_PORT} \
  -e ISA_SYNC_POLL_MS=1000 -e ISA_COMMENT_POLL_MS=1000 \
  -v "$(pwd)/.vn-w-data:/data" immich-shared-albums:demo >/dev/null
docker run -d --name vn-r-fast --network ${B_NET} --user 0:0 -p 127.0.0.1:${R_PORT}:${R_PORT} \
  -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="${RKEY}" \
  -e ISA_HOUSEHOLD_NAME="Nudge Verify Receiver" -e ISA_PORT=${R_PORT} \
  -e ISA_SYNC_POLL_MS=1000 -e ISA_COMMENT_POLL_MS=1000 -e ISA_TEST_HOOKS=1 \
  -v "$(pwd)/.vn-r-data:/data" immich-shared-albums:demo >/dev/null
for i in $(seq 1 30); do curl -sf -m 2 "http://localhost:${W_PORT}/api/server/ping" >/dev/null 2>&1 \
  && curl -sf -m 2 "http://localhost:${R_PORT}/api/server/ping" >/dev/null 2>&1 && break; sleep 1; done
LINK=$(curl -sf -X POST "http://localhost:${W_PORT}/immich-shared-albums/pairings" \
  -H "x-api-key: ${WKEY}" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("link",""))' 2>/dev/null || true)
[ -n "${LINK:-}" ] && check "the writer mints a pairing link" 0 || check "the writer mints a pairing link" 1
curl -sf -m 60 -X POST "http://localhost:${R_PORT}/immich-shared-albums/pair" \
  -H 'Content-Type: application/json' -H "x-api-key: ${RKEY}" -d "{\"link\":\"${LINK}\"}" >/dev/null \
  && check "the receiver redeems it" 0 || check "the receiver redeems it" 1
sleep 5   # both directories exchange at the fast cadence, so the markers exist

echo "-- phase 2: both sidecars restart with 300s backstops --"
docker rm -f vn-w-fast vn-r-fast >/dev/null
docker run -d --name vn-w --network ${D_NET} --user 0:0 -p 127.0.0.1:${W_PORT}:${W_PORT} \
  -e ISA_IMMICH_URL=http://immich-d:2283 -e ISA_IMMICH_API_KEY="${WKEY}" \
  -e ISA_HOUSEHOLD_NAME="Nudge Verify Writer" -e ISA_PORT=${W_PORT} \
  -e ISA_SYNC_POLL_MS=${SLOW} -e ISA_COMMENT_POLL_MS=${SLOW} \
  -v "$(pwd)/.vn-w-data:/data" immich-shared-albums:demo >/dev/null
docker run -d --name vn-r --network ${B_NET} --user 0:0 -p 127.0.0.1:${R_PORT}:${R_PORT} \
  -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="${RKEY}" \
  -e ISA_HOUSEHOLD_NAME="Nudge Verify Receiver" -e ISA_PORT=${R_PORT} \
  -e ISA_SYNC_POLL_MS=${SLOW} -e ISA_COMMENT_POLL_MS=${SLOW} -e ISA_TEST_HOOKS=1 \
  -v "$(pwd)/.vn-r-data:/data" immich-shared-albums:demo >/dev/null
for i in $(seq 1 30); do curl -sf -m 2 "http://localhost:${W_PORT}/api/server/ping" >/dev/null 2>&1 \
  && curl -sf -m 2 "http://localhost:${R_PORT}/api/server/ping" >/dev/null 2>&1 && break; sleep 1; done
sleep 2

status() {
  curl -sf "http://localhost:${R_PORT}/immich-shared-albums/sync/status" \
    -H "x-api-key: ${RKEY}" 2>/dev/null || echo '{}'
}
ticks() { status | python3 -c 'import json,sys;t=json.load(sys.stdin).get("ticks",{});print(t.get("watcher",0),t.get("invites",0),t.get("comments",0))'; }
nudges() { status | python3 -c 'import json,sys;n=json.load(sys.stdin).get("nudges",{});print(n.get("index",0),n.get("directory",0))'; }

echo "-- phase 3a: ${STILL}s of stillness — no timer may fire before the measurement --"
read T1W T1I T1C <<< "$(ticks)"
sleep "${STILL}"
read T2W T2I T2C <<< "$(ticks)"
if [ "${T2W}" = "${T1W}" ] && [ "${T2I}" = "${T1I}" ] && [ "${T2C}" = "${T1C}" ]; then
  check "no lane ticked in ${STILL}s — the 300s backstops are quiet" 0
else
  check "no lane ticked in ${STILL}s — the 300s backstops are quiet" 1 "${T1W}/${T1I}/${T1C} -> ${T2W}/${T2I}/${T2C}"
fi

echo "-- phase 3b: an album write through the writer's own proxy — the measurement --"
read N1X N1D <<< "$(nudges)"
ALBUM="nudge verify $(date +%s)"
curl -sf -X POST "http://localhost:${W_PORT}/api/albums" -H "x-api-key: ${WKEY}" \
  -H 'Content-Type: application/json' -d "{\"albumName\":\"${ALBUM}\"}" >/dev/null \
  && check "the write went through the writer's proxy" 0 || check "the write went through the writer's proxy" 1

START=$(date +%s)
WOKE=0
for i in $(seq 1 "${WINDOW}"); do
  read T3W T3I T3C <<< "$(ticks)"
  read N2X N2D <<< "$(nudges)"
  if [ "${T3I}" -gt "${T2I}" ] && { [ "${N2X}" -gt "${N1X}" ] && [ "${N2D}" -gt "${N1D}" ]; }; then WOKE=1; break; fi
  sleep 1
done
ELAPSED=$(( $(date +%s) - START ))
if [ "${WOKE}" = "1" ]; then
  check "the write woke the receiver's lanes in ${ELAPSED}s (<${WINDOW}s; its backstop ${SLOW}ms away, ${STILL}s of stillness before it)" 0
  # BOTH tells must land: the index nudge refreshes the receiver's view of what the writer
  # publishes, and the directory nudge wakes the receiver's invites lane. One without the other
  # is a shadowed route or a dead tell, not a wake.
  check "the receiver counted BOTH channel nudges (index and directory)" $(( (N2X > N1X && N2D > N1D) ? 0 : 1 )) "index ${N1X}->${N2X}, directory ${N1D}->${N2D}"
  check "and the invites LANE swept — a wake, not just a delivered tell" $(( T3I > T2I ? 0 : 1 )) "invites ticks ${T2I} -> ${T3I}"
else
  check "the write woke the receiver's lanes" 1 "no invites tick in ${WINDOW}s (ticks ${T2W}/${T2I}/${T2C}, nudges index ${N1X}->${N2X:-?} directory ${N1D}->${N2D:-?})"
fi

echo
if [ "${FAIL}" = "0" ]; then echo "✅ ALL PASS (${PASS})"; exit 0; else echo "💥 ${FAIL} FAILURES (${PASS} passed)"; exit "${FAIL}"; fi
