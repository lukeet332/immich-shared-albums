#!/bin/bash
# Fully-isolated E2E: mock C (origin) <-> mock B (joiner). Never touches production A.
# Rebuilds sidecar image, redeploys B+C, full-purges both, runs assertion suite.
set -uo pipefail
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
DIR=~/Documents/immich-shared-albums
BKEY=$(cut -d= -f2- "$DIR/demo/.env")
CKEY=$(cut -d= -f2- "$DIR/demo/household-c/.env")

echo "== build image =="
cd "$DIR" && docker build -q -t immich-shared-albums:demo . >/dev/null

purge() { # base key : delete all albums, sidecar users, non-admin assets, reset sidecar state
  local BASE=$1 KEY=$2
  for AL in $(curl -s $BASE/api/albums -H "x-api-key: $KEY" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/albums/$AL -H "x-api-key: $KEY" -o /dev/null; done
  for U in $(curl -s $BASE/api/admin/users -H "x-api-key: $KEY" | python3 -c "import json,sys;[print(u['id']) for u in json.load(sys.stdin) if u['email'].endswith('@sidecar.local')]" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/admin/users/$U -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"force":true}' -o /dev/null; done
  local IDS=$(curl -s -X POST $BASE/api/search/metadata -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"size":500}' | python3 -c "import json,sys;print(json.dumps([i['id'] for i in json.load(sys.stdin)['assets']['items']]))" 2>/dev/null)
  [ "${IDS:-[]}" != "[]" ] && curl -s -X DELETE $BASE/api/assets -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d "{\"ids\":$IDS,\"force\":true}" -o /dev/null
}

echo "== redeploy + purge B =="
cd "$DIR/demo" && docker compose up -d --force-recreate sidecar-b >/dev/null 2>&1
purge http://localhost:2284 "$BKEY"; rm -f b-sidecar/state.json; docker compose restart sidecar-b >/dev/null 2>&1

echo "== redeploy + purge C =="
cd "$DIR/demo/household-c" && docker compose up -d --force-recreate sidecar-c >/dev/null 2>&1
purge http://localhost:2285 "$CKEY"; rm -f c-sidecar/state.json; docker compose restart sidecar-c >/dev/null 2>&1
sleep 4

echo "== harden C like production (passwordLogin off) =="
CFGJSON=$(curl -s http://localhost:2285/api/system-config -H "x-api-key: $CKEY" | python3 -c "import json,sys; c=json.load(sys.stdin); c['passwordLogin']['enabled']=False; print(json.dumps(c))")
curl -s -X PUT http://localhost:2285/api/system-config -H "x-api-key: $CKEY" -H 'Content-Type: application/json' -d "$CFGJSON" -o /dev/null -w "C passwordLogin disabled: %{http_code}\n"

echo "== E2E (C origin -> B joiner) =="
cd "$DIR/demo/e2e"
A_URL=http://localhost:2285 AKEY=$CKEY A_ALBUM=__CREATE__ \
B_URL=http://localhost:2284 BKEY=$BKEY B_SIDECAR=http://localhost:8301 \
ORIGIN_SIDECAR=http://192.168.0.11:8302 \
node e2e-test.mjs
