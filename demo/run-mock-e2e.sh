#!/bin/bash
# Fully-isolated E2E: mock C (origin) <-> mock B (joiner). Never touches production A.
# Rebuilds sidecar image, redeploys B+C, full-purges both, runs assertion suite.
set -uo pipefail
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BKEY=$(grep -m1 "^B_API_KEY=" "$DIR/demo/.env" | cut -d= -f2-)
B_SIDECAR_API_KEY=$(grep -m1 "^B_SIDECAR_API_KEY=" "$DIR/demo/.env" | cut -d= -f2-)
CKEY=$(grep -m1 "^C_API_KEY=" "$DIR/demo/household-c/.env" | cut -d= -f2-)

# The shared peer network is needed whether or not the image is rebuilt (CI prebuilds it).
docker network inspect isa-demo >/dev/null 2>&1 || docker network create isa-demo
if [ -z "${SKIP_BUILD:-}" ]; then
echo "== build image =="
  cd "$DIR" && docker build -q -t immich-shared-albums:demo . >/dev/null
else
  echo "== SKIP_BUILD set: testing against the existing image =="
fi

# Delete a sidecar's state as ROOT, but only while the container is stopped.
#
# Root matters: the rig runs sidecars as root (`user: "0:0"`), so state.db is root-owned and a
# plain `rm` as the runner fails — which the CI runner hits even though a Docker Desktop bind
# mount does not. Stopped matters: a running sidecar holds the file open and rewrites it, which is
# the stale-state bug this replaced. A throwaway container has the same volume mounted, so it can
# delete what the host cannot.
reset_state() { # reset_state <compose-dir> <service>
  local dir=$1 svc=$2
  ( cd "$dir" && docker compose stop "$svc" >/dev/null 2>&1 )
  ( cd "$dir" && docker compose run --rm --no-deps --entrypoint sh "$svc" \
      -c 'rm -f /data/state.db /data/state.db-wal /data/state.db-shm' >/dev/null 2>&1 )
  ( cd "$dir" && docker compose start "$svc" >/dev/null 2>&1 )
}

# Sidecar state is read THROUGH the sidecar's container, never with a host sqlite3. The database is
# WAL-mode and SQLite's WAL protocol relies on POSIX locks to know who else has it open; across a
# Docker Desktop bind mount those locks never reach the VM, so a host-side sqlite3 thinks it is the
# LAST connection and deletes state.db-wal/-shm when it exits. The running sidecar then writes into
# an unlinked WAL that nobody can read, and a restarted sidecar has forgotten everything since.
# (2026-09-18: `state.db-wal (deleted)` on PID 1 of all three rig sidecars — the cause of every
# local-only e2e failure.) A reader inside the container shares the locks and is safe. Linux (CI)
# never had the problem, which is why it looked like flakiness. One row per line, first column.
SQLITE_COL='const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/state.db",{readOnly:true});process.stdout.write(db.prepare(process.argv[1]).all().map(r=>Object.values(r)[0]).join("\n"))'
sidecar_col() { # sidecar_col <service> <sql> — run from that household's compose dir
  docker compose exec -T "$1" node -e "$SQLITE_COL" "$2" 2>/dev/null
}

purge() { # base key service : delete all albums, sidecar users, non-admin assets (run from the compose dir)
  local BASE=$1 KEY=$2 SVC=${3:-}
  # mirror albums are owned by utility users — only their own keys (in the state store) can delete them
  local CONTRIB=""
  [ -n "$SVC" ] && CONTRIB=$(sidecar_col "$SVC" "SELECT apiKey FROM contributors")
  if [ -n "$CONTRIB" ]; then
    for CK in $CONTRIB; do
      for AL in $(curl -s $BASE/api/albums -H "x-api-key: $CK" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null); do
        curl -s -X DELETE $BASE/api/albums/$AL -H "x-api-key: $CK" -o /dev/null; done
    done
  fi
  for AL in $(curl -s $BASE/api/albums -H "x-api-key: $KEY" | python3 -c "import json,sys;[print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/albums/$AL -H "x-api-key: $KEY" -o /dev/null; done
  # both domains: the product made a clean break at v1, but a dev rig may still hold pre-v1 bots
  for U in $(curl -s $BASE/api/admin/users -H "x-api-key: $KEY" | python3 -c "import json,sys;[print(u['id']) for u in json.load(sys.stdin) if u['email'].endswith('@immich-shared-albums.internal') or u['email'].endswith('@immich-shared-albums.invalid') or u['email'].endswith('@immich-shared-albums.local') or u['email'].endswith('@sidecar.local')]" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/admin/users/$U -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"force":true}' -o /dev/null; done
  local IDS=$(curl -s -X POST $BASE/api/search/metadata -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"size":500}' | python3 -c "import json,sys;print(json.dumps([i['id'] for i in json.load(sys.stdin)['assets']['items']]))" 2>/dev/null)
  [ "${IDS:-[]}" != "[]" ] && curl -s -X DELETE $BASE/api/assets -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d "{\"ids\":$IDS,\"force\":true}" -o /dev/null
}

# D (third household — relay coverage): a first-time local rig provisions its key here; CI
# writes it beforehand.
cd "$DIR/demo/household-d"
if [ ! -f .env ]; then
  docker compose up -d immich-d db-d redis-d >/dev/null 2>&1
  echo "D_API_KEY=$("$DIR/demo/ci/provision-mock.sh" http://localhost:2286 "Demo Dave")" > .env
fi
DKEY=$(grep -m1 "^D_API_KEY=" .env | cut -d= -f2-)

# Redeploy the sidecar, purge its Immich, reset its state — for one household, in a subshell so
# the cd is contained (purge and the state reads run from the compose dir).
# Compose output is kept (prefixed per household) rather than discarded: a redeploy that fails
# here used to be invisible, and the run then died later with a message about something else.
redeploy() { # redeploy <compose-dir> <service> <immich-url> <admin-key>
  (
    cd "$1" && docker compose up -d --force-recreate "$2" 2>&1 | sed "s/^/  [$2] /"
    purge "$3" "$4" "$2"
    reset_state "$1" "$2"
  )
}
# The three households are independent stacks on separate ports and separate compose projects,
# so they redeploy at once: the wall is the slowest one, not the sum.
echo "== redeploy + purge B, C, D (in parallel) =="
redeploy "$DIR/demo" sidecar-b http://localhost:2284 "$BKEY" &
redeploy "$DIR/demo/household-c" sidecar-c http://localhost:2285 "$CKEY" &
redeploy "$DIR/demo/household-d" sidecar-d http://localhost:2286 "$DKEY" &
wait
# The reset restarts each sidecar from nothing; the preflight below reads a state.db a booting
# sidecar may not have created yet. The sidecar opens its store at import, before it listens, so
# "health answers" is also "that file exists" — wait on that, bounded, rather than on a sleep.
# On failure, say what the containers were actually doing instead of guessing later.
for pair in "8301:$DIR/demo:sidecar-b" "8302:$DIR/demo/household-c:sidecar-c" "8303:$DIR/demo/household-d:sidecar-d"; do
  port=${pair%%:*}; rest=${pair#*:}; cdir=${rest%:*}; svc=${rest##*:}
  for i in $(seq 1 60); do curl -sf "http://localhost:$port/immich-shared-albums/health" >/dev/null && break; sleep 1; done
  if ! curl -sf "http://localhost:$port/immich-shared-albums/health" >/dev/null; then
    echo "  !! $svc on :$port did not come up after the reset — aborting before the suite"
    ( cd "$cdir" && docker compose ps -a && docker compose logs --tail 40 "$svc" ) 2>&1 | sed 's/^/     /'
    exit 1
  fi
done

# Fail fast on a rig that did not actually reset. A stale state.db carries bot keys whose
# Immich accounts the purge already deleted, and every later assertion then fails with
# "Invalid API key" — which reads exactly like a product bug and has cost whole runs. Cheap to
# check, so check it before spending nine minutes finding out the hard way.
echo "== preflight: sidecars start from empty state =="
for triple in "$DIR/demo:sidecar-b:B" "$DIR/demo/household-c:sidecar-c:C" "$DIR/demo/household-d:sidecar-d:D"; do
  cdir=${triple%%:*}; rest=${triple#*:}; svc=${rest%%:*}; label=${rest##*:}
  n=$( (cd "$cdir" && sidecar_col "$svc" "SELECT COUNT(*) FROM mappings") || echo "?")
  if [ "$n" != "0" ]; then
    echo "  !! $label sidecar kept $n mapping(s) across the reset — aborting before the suite"
    exit 1
  fi
  echo "  $label starts clean"
done

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
