#!/bin/bash
# Provision a fresh mock Immich for CI: wait for boot, admin sign-up, login,
# mint an all-permissions API key. Prints the key on stdout (nothing else).
# Usage: provision-mock.sh <base-url>
set -euo pipefail
BASE=$1
EMAIL=admin@e2e.local
PASS=e2e-admin-pass-1

for i in $(seq 1 90); do
  curl -sf "$BASE/api/server/ping" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$BASE/api/server/ping" >/dev/null || { echo "immich at $BASE never came up" >&2; exit 1; }

# idempotent: sign-up 400s if an admin already exists
curl -s -X POST "$BASE/api/auth/admin-sign-up" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"E2E Admin\"}" -o /dev/null

TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])')

curl -sf -X POST "$BASE/api/api-keys" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"e2e","permissions":["all"]}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["secret"])'
