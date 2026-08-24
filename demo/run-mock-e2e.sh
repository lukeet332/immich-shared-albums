#!/bin/bash
# Fully-isolated E2E: mock C (origin) <-> mock B (joiner). Never touches production A.
# Rebuilds sidecar image, redeploys B+C, full-purges both, runs assertion suite.
set -uo pipefail
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BKEY=$(grep -m1 "^B_API_KEY=" "$DIR/demo/.env" | cut -d= -f2-)
B_SIDECAR_API_KEY=$(grep -m1 "^B_SIDECAR_API_KEY=" "$DIR/demo/.env" | cut -d= -f2-)
CKEY=$(grep -m1 "^C_API_KEY=" "$DIR/demo/household-c/.env" | cut -d= -f2-)

if [ -z "${SKIP_BUILD:-}" ]; then
  docker network inspect isa-demo >/dev/null 2>&1 || docker network create isa-demo
echo "== build image =="
  cd "$DIR" && docker build -q -t immich-shared-albums:demo . >/dev/null
else
  echo "== SKIP_BUILD set: testing against the existing image =="
fi

purge() { # base key statedir : delete all albums, sidecar users, non-admin assets, reset sidecar state
  local BASE=$1 KEY=$2 STATEDIR=${3:-}
  # mirror albums are owned by utility users — only their own keys (in the state store) can delete them
  # (schema v1 keeps contributors in a real table; the kv-blob read is a fallback so this can
  # still purge a rig last written by pre-v1 code)
  local CONTRIB=""
  if [ -f "$STATEDIR/state.db" ]; then
    CONTRIB=$(sqlite3 "$STATEDIR/state.db" "SELECT '[' || COALESCE(group_concat(json_object('key', apiKey)), '') || ']' FROM contributors" 2>/dev/null)
    [ -n "$CONTRIB" ] && [ "$CONTRIB" != "[]" ] || CONTRIB=$(sqlite3 "$STATEDIR/state.db" "SELECT value FROM kv WHERE name='contributors'" 2>/dev/null)
  fi
  if [ -n "$CONTRIB" ] && [ "$CONTRIB" != "[]" ]; then
    for CK in $(echo "$CONTRIB" | python3 -c "
import json,sys
d = json.load(sys.stdin)
vals = d if isinstance(d, list) else d.values()
print('\n'.join(c.get('apiKey') or c.get('key') or '' for c in vals))" 2>/dev/null); do
      for AL in $(curl -s $BASE/api/albums -H "x-api-key: $CK" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null); do
        curl -s -X DELETE $BASE/api/albums/$AL -H "x-api-key: $CK" -o /dev/null; done
    done
  fi
  for AL in $(curl -s $BASE/api/albums -H "x-api-key: $KEY" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/albums/$AL -H "x-api-key: $KEY" -o /dev/null; done
  # both domains: the product made a clean break at v1, but a dev rig may still hold pre-v1 bots
  for U in $(curl -s $BASE/api/admin/users -H "x-api-key: $KEY" | python3 -c "import json,sys;[print(u['id']) for u in json.load(sys.stdin) if u['email'].endswith('@immich-shared-albums.invalid') or u['email'].endswith('@immich-shared-albums.local') or u['email'].endswith('@sidecar.local')]" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/admin/users/$U -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"force":true}' -o /dev/null; done
  local IDS=$(curl -s -X POST $BASE/api/search/metadata -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"size":500}' | python3 -c "import json,sys;print(json.dumps([i['id'] for i in json.load(sys.stdin)['assets']['items']]))" 2>/dev/null)
  [ "${IDS:-[]}" != "[]" ] && curl -s -X DELETE $BASE/api/assets -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d "{\"ids\":$IDS,\"force\":true}" -o /dev/null
}

echo "== redeploy + purge B =="
cd "$DIR/demo" && docker compose up -d --force-recreate sidecar-b >/dev/null 2>&1
purge http://localhost:2284 "$BKEY" b-sidecar; docker compose exec -T sidecar-b rm -f /data/state.db /data/state.db-wal /data/state.db-shm 2>/dev/null; docker compose restart sidecar-b >/dev/null 2>&1

echo "== redeploy + purge C =="
cd "$DIR/demo/household-c" && docker compose up -d --force-recreate sidecar-c >/dev/null 2>&1
purge http://localhost:2285 "$CKEY" c-sidecar; docker compose exec -T sidecar-c rm -f /data/state.db /data/state.db-wal /data/state.db-shm 2>/dev/null; docker compose restart sidecar-c >/dev/null 2>&1

echo "== redeploy + purge D (third household — relay coverage) =="
cd "$DIR/demo/household-d"
if [ ! -f .env ]; then
  docker compose up -d immich-d db-d redis-d >/dev/null 2>&1
  echo "D_API_KEY=$("$DIR/demo/ci/provision-mock.sh" http://localhost:2286 "Demo Dave")" > .env
fi
DKEY=$(grep -m1 "^D_API_KEY=" .env | cut -d= -f2-)
docker compose up -d --force-recreate sidecar-d >/dev/null 2>&1
purge http://localhost:2286 "$DKEY" d-sidecar; docker compose exec -T sidecar-d rm -f /data/state.db /data/state.db-wal /data/state.db-shm 2>/dev/null; docker compose restart sidecar-d >/dev/null 2>&1
sleep 4

echo "== harden C like production (passwordLogin off) =="
CFGJSON=$(curl -s http://localhost:2285/api/system-config -H "x-api-key: $CKEY" | python3 -c "import json,sys; c=json.load(sys.stdin); c['passwordLogin']['enabled']=False; print(json.dumps(c))")
curl -s -X PUT http://localhost:2285/api/system-config -H "x-api-key: $CKEY" -H 'Content-Type: application/json' -d "$CFGJSON" -o /dev/null -w "C passwordLogin disabled: %{http_code}\n"

echo "== E2E (C origin -> B joiner) =="
cd "$DIR/demo/e2e"
A_URL=http://localhost:2285 AKEY=$CKEY A_ALBUM=__CREATE__ \
B_URL=http://localhost:2284 BKEY=$BKEY B_SIDECAR=http://localhost:8301 \
B_SIDECAR_API_KEY=${B_SIDECAR_API_KEY:-} \
D_URL=http://localhost:2286 DKEY=$DKEY D_SIDECAR=http://localhost:8303 \
ORIGIN_SIDECAR=${ORIGIN_SIDECAR:-http://host.docker.internal:8302} \
node e2e-test.mjs
