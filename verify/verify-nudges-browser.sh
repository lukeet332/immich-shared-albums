#!/bin/bash
# verify-nudges-browser.sh — the wrapper for verify-nudges-browser.mjs: recreates the rig's B
# and C sidecars with 300s backstops (their state, peers and index views persist), runs the
# hand-driven real-browser proof against them, and restores the rig's normal 1s cadence after —
# whatever the outcome. Rig-only: it reaches nothing but this repo's own compose projects.
# Preconditions: demo/run-mock-e2e.sh has run (the admin accounts exist) and the rig is up.
set -uo pipefail
cd "$(dirname "$0")/.."

BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)
CKEY=$(grep -m1 '^C_API_KEY=' demo/household-c/.env | cut -d= -f2-)
[ -n "${BKEY:-}" ] && [ -n "${CKEY:-}" ] || { echo "❌ the rig's .env keys are missing — run demo/run-mock-e2e.sh first"; exit 1; }
for p in "${PORT_IMMICH_B:-2284}" "${PORT_IMMICH_C:-2285}"; do
  curl -sf -m 3 "http://localhost:$p/api/server/ping" >/dev/null || { echo "❌ the rig is not up at :$p"; exit 1; }
done

SLOW=300000
restore_cadence() {
  (cd demo && docker compose up -d --force-recreate >/dev/null 2>&1)
  (cd demo/household-c && docker compose up -d --force-recreate >/dev/null 2>&1)
}
trap restore_cadence EXIT

echo "-- both households' sidecars restart with 300s backstops (state persists) --"
# ISA_TRACE_SYNC on for the run: a failure is diagnosable only from the sidecars' own traces,
# and the rig compose defaults it to false.
(cd demo && ISA_SYNC_POLL_MS=$SLOW ISA_COMMENT_POLL_MS=$SLOW ISA_TRACE_SYNC=true docker compose up -d --force-recreate 2>&1 | tail -1)
(cd demo/household-c && ISA_SYNC_POLL_MS=$SLOW ISA_COMMENT_POLL_MS=$SLOW ISA_TRACE_SYNC=true docker compose up -d --force-recreate 2>&1 | tail -1)
for i in $(seq 1 45); do
  curl -sf -m 2 "http://localhost:${PORT_SIDECAR_B:-8301}/api/server/ping" >/dev/null 2>&1 \
    && curl -sf -m 2 "http://localhost:${PORT_SIDECAR_C:-8302}/api/server/ping" >/dev/null 2>&1 && break
  sleep 1
done
sleep 2

echo "-- the real-browser proof --"
(cd demo/e2e && CKEY="$CKEY" B_EMAIL=admin@e2e.local B_PASS=e2e-admin-pass-1 \
  HOST_RESOLVER_RULES="MAP host.docker.internal 127.0.0.1" \
  node ../../verify/verify-nudges-browser.mjs)
RESULT=$?

# On failure the sidecars' own traces are the only witness — the cadence restore below recreates
# them, which wipes the logs, so they are printed first. ISA_TRACE_SYNC is rig-on, so every peer
# request and its elapsed time is in there.
if [ "${RESULT}" != "0" ]; then
  echo "-- writer sidecar (outbound tells) --"
  docker logs household-b-sidecar-b-1 2>&1 | grep -E "nudge|lane woke|peer request|error" | tail -40
  echo "-- receiver sidecar (inbound tells) --"
  docker logs household-c-sidecar-c-1 2>&1 | grep -E "nudge|lane woke|peer request|error" | tail -40
fi

echo "-- rig cadence restored --"
echo "verify-nudges-browser.mjs exit: ${RESULT}"
exit "${RESULT}"
