#!/bin/bash
# Provision a fresh mock Immich for CI: wait for boot, admin sign-up, login, mint an API key.
# Prints the key on stdout (nothing else). The default key is all-permissions (the test RUNNER
# acts as humans and admins); pass --scoped to mint the sidecar's key with exactly the permission
# lists from src/immich/admin_key.rs (REQUIRED_ADMIN_PERMISSIONS plus OAUTH_ONLY_PERMISSIONS —
# the rig exercises the OAuth-only flow, whose systemConfig scopes are optional on real
# installs). CI running the whole suite on that key is the proof the documented list is
# sufficient.
# Usage: provision-mock.sh <base-url> [admin-name] [--scoped]
set -euo pipefail
# Absolute first: the script is invoked from the repo root by CI, but it must work from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_KEY_FILE="$(cd "$SCRIPT_DIR/../.." && pwd)/src/immich/admin_key.rs"
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
  PERMS=$(python3 - "$SRC_KEY_FILE" <<'EOF'
import json, os, pathlib, sys
# The permission lists live in the Rust source — parse the consts directly, so the rig's key can
# never drift from what the sidecar actually exercises. Resolved from the script's own location,
# so the script works from any working directory.
src = (pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('src/immich/admin_key.rs')).read_text()

def grab(name: str) -> list[str]:
    """Every quoted scope inside `pub const <name> ... = [ ... ];` — one line or many."""
    out: list[str] = []
    inside = False
    for line in src.splitlines():
        if not inside and line.startswith(f"pub const {name}"):
            inside = True
        if inside:
            out += [tok for tok in line.split('"')[1::2] if tok]
            if "];" in line:
                break
    if not out:
        raise SystemExit(f"no scopes found for {name} in src/immich/admin_key.rs")
    return out

scopes = grab("REQUIRED_ADMIN_PERMISSIONS") + grab("OAUTH_ONLY_PERMISSIONS")
print(json.dumps(sorted(set(scopes))))
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
