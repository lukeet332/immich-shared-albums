#!/bin/bash
# Provision a fresh mock Immich for CI: wait for boot, admin sign-up, login, mint an API key.
# Prints the key on stdout (nothing else). The default key is all-permissions (the test RUNNER
# acts as humans and admins); pass --scoped to mint the sidecar's key with exactly the
# REQUIRED_ADMIN_PERMISSIONS list from src/immich/admin-key.ts — CI running the whole suite on
# that key is the proof the documented list is sufficient.
# Usage: provision-mock.sh <base-url> [admin-name] [--scoped]
set -euo pipefail
BASE=$1
NAME=${2:-E2E Admin}
EMAIL=admin@e2e.local
PASS=e2e-admin-pass-1

for i in $(seq 1 90); do
  curl -sf "$BASE/api/server/ping" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$BASE/api/server/ping" >/dev/null || { echo "immich at $BASE never came up" >&2; exit 1; }

# idempotent: sign-up 400s if an admin already exists
curl -s -X POST "$BASE/api/auth/admin-sign-up" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"$NAME\"}" -o /dev/null

TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])')

if [ "${3:-}" = "--scoped" ]; then
  PERMS=$(python3 - <<'EOF'
import re, json, pathlib
src = pathlib.Path(__file__ if False else 'src/immich/admin-key.ts').read_text()
def grab(name):
    body = re.search(name + r"\s*=\s*\[(.*?)\]", src, re.S).group(1)
    return re.findall(r"'([^']+)'", body)
print(json.dumps(grab('REQUIRED_ADMIN_PERMISSIONS') + grab('OAUTH_ONLY_PERMISSIONS')))
EOF
)
  NAME=sidecar-scoped
else
  PERMS='["all"]'
  NAME=e2e
fi
curl -sf -X POST "$BASE/api/api-keys" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$NAME\",\"permissions\":$PERMS}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["secret"])'
