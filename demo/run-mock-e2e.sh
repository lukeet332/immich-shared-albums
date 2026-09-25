#!/bin/bash
# Fully-isolated E2E: mock C (origin) <-> mock B (joiner) <-> mock D (relay). It never touches a
# real server — and it is built so that it CANNOT, even on a host that also runs a real Immich:
#
#   * every host port the rig publishes is overridable (PORT_* below) and bound to loopback;
#   * purge() — which force-deletes albums, bot users and assets over HTTP — runs only after
#     require_mock has proved that the port it is about to hit is published by a container of one
#     of this rig's own compose projects. A wrong port cannot delete anything: it exits 2 first;
#   * the suite's one name-addressed destructive verb (the kill test) checks the same label;
#   * one run at a time (a lock), and the image is labelled with the commit it was built from.
#
# Keep host-specific values (a shifted port map, a different bind address) in a file OUTSIDE the
# repo and `source` it before running. Never in the repo, never in the compose files.
set -uo pipefail
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ---- the rig's address map ------------------------------------------------------------------
# Loopback by default: the mock Immichs carry a known admin password, so they are reachable from
# this host only. RIG_BIND=0.0.0.0 opens them to the LAN (testing from a phone). Nothing inside
# the rig depends on host ports — containers reach each other by name on the shared isa-demo
# network, and joins carry an iroh endpoint token — so the map is free to move.
RIG_BIND=${RIG_BIND:-127.0.0.1}
# RIG_UP_ONLY=1 stops after the rig is brought up, purged and seeded, and prints what to click. For
# a HAND test: the same guarded bring-up as a run, but no suite, and C keeps password login so a
# person can actually sign in. A later run of this script purges whatever the hand test left.
RIG_UP_ONLY=${RIG_UP_ONLY:-}
# RIG_MOCKS_ONLY=1 brings the mock Immichs up and STOPS the rig's own sidecars, for a sidecar that
# `deploy/install.sh` is about to install instead. It implies up-only: the suite needs the rig's own.
RIG_MOCKS_ONLY=${RIG_MOCKS_ONLY:-}
PORT_IMMICH_B=${PORT_IMMICH_B:-2284}
PORT_IMMICH_C=${PORT_IMMICH_C:-2285}
PORT_IMMICH_D=${PORT_IMMICH_D:-2286}
PORT_SIDECAR_B=${PORT_SIDECAR_B:-8301}
PORT_SIDECAR_C=${PORT_SIDECAR_C:-8302}
PORT_SIDECAR_D=${PORT_SIDECAR_D:-8303}
export RIG_BIND PORT_IMMICH_B PORT_IMMICH_C PORT_IMMICH_D PORT_SIDECAR_B PORT_SIDECAR_C PORT_SIDECAR_D
# The compose projects this rig owns — the `name:` in each compose file. Anything else on this
# docker daemon is not ours to touch, and every guard below refuses it.
RIG_PROJECT_B=${RIG_PROJECT_B:-household-b}
RIG_PROJECT_C=${RIG_PROJECT_C:-household-c}
RIG_PROJECT_D=${RIG_PROJECT_D:-household-d}
RIG_PROJECTS="$RIG_PROJECT_B $RIG_PROJECT_C $RIG_PROJECT_D"
export RIG_PROJECT_B RIG_PROJECT_C RIG_PROJECT_D RIG_PROJECTS

# ---- one run at a time ----------------------------------------------------------------------
# Two runs share the same containers and databases; the second corrupts the first's results and
# its own. mkdir is atomic everywhere this runs (macOS has no flock).
LOCK=${RIG_LOCK:-${TMPDIR:-/tmp}/immich-shared-albums-rig.lock}
if ! mkdir "$LOCK" 2>/dev/null; then
  other=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "!! another rig run (pid $other) holds $LOCK — refusing to run two at once" >&2
    exit 3
  fi
  rm -rf "$LOCK" && mkdir "$LOCK" || exit 3
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# ---- refuse to purge anything that is not this rig's own mock -------------------------------
# purge() addresses its target by PORT. Without this, a wrong port in the map would point the
# force-deletes below at whatever real Immich answers there. The check keys on the compose-project
# LABEL of the container publishing the port, not on the port number, so a port-map mistake stops
# here having deleted nothing. Never work around a refusal by aiming at another host.
require_mock() { # require_mock <base-url>
  local url=$1 port id owner
  port=$(printf '%s' "$url" | sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#')
  id=$(docker ps -q --filter "publish=$port" | head -1)
  if [ -z "$id" ]; then
    echo "REFUSING: nothing on this docker daemon publishes port $port — will not purge $url." >&2
    echo "  Check PORT_IMMICH_{B,C,D} and that the rig is up. Do not point the map at another host." >&2
    exit 2
  fi
  owner=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id")
  case " $RIG_PROJECTS " in
    *" $owner "*) : ;;
    *)
      echo "REFUSING: port $port is $(docker inspect -f '{{.Name}}' "$id") from compose project '${owner:-none}'," >&2
      echo "  which is not one of this rig's ($RIG_PROJECTS). Purging it would delete real users" >&2
      echo "  and photos. Fix the port map instead." >&2
      exit 2
      ;;
  esac
}

BKEY=$(grep -m1 "^B_API_KEY=" "$DIR/demo/.env" | cut -d= -f2-)
B_SIDECAR_API_KEY=$(grep -m1 "^B_SIDECAR_API_KEY=" "$DIR/demo/.env" | cut -d= -f2-)
CKEY=$(grep -m1 "^C_API_KEY=" "$DIR/demo/household-c/.env" | cut -d= -f2-)

# The shared peer network is needed whether or not the image is rebuilt (CI prebuilds it).
docker network inspect isa-demo >/dev/null 2>&1 || docker network create isa-demo
# The image carries the commit it was built from, so a SKIP_BUILD run can say what it is really
# testing instead of quietly testing whatever image was lying around.
COMMIT=$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "== build image (commit $COMMIT) =="
  # ISA_DOCKERFILE names WHICH Dockerfile builds the rig's sidecar, so the port's replacement can be
  # run through this whole suite before it becomes the default. Every normal run uses the default.
  IMAGE_DOCKERFILE="${ISA_DOCKERFILE:-Dockerfile}"
  echo "   (from $IMAGE_DOCKERFILE)"
  # ISA_BUILD_ARGS exists so a build can carry extra --build-arg flags, e.g. debug symbols for a
  # hang that has to be diagnosed with gdb. Every normal run passes none.
  ( cd "$DIR" && docker build -q --label "isa.commit=$COMMIT" -f "$IMAGE_DOCKERFILE" -t immich-shared-albums:demo ${ISA_BUILD_ARGS:-} . >/dev/null ) \
    || { echo "!! image build failed — not testing a stale image" >&2; exit 1; }
else
  built=$(docker inspect -f '{{index .Config.Labels "isa.commit"}}' immich-shared-albums:demo 2>/dev/null || true)
  echo "== SKIP_BUILD set: testing the existing image (built from ${built:-an unlabelled commit}; HEAD is $COMMIT) =="
  [ "$built" = "$COMMIT" ] || echo "  !! that image is NOT built from HEAD — the results describe ${built:-something else}, not this checkout"
fi

# The iroh probe is the INDEPENDENT JavaScript oracle, and it is NOT the image under test: under
# ISA_DOCKERFILE=rust/Dockerfile the sidecar image has no node at all, and every probe would die with
# "exec: node: not found", which reads as a product failure. So it is built from the root Dockerfile
# whatever the sidecar uses — and it is built OUTSIDE the branch above, because a SKIP_BUILD run
# (CI pre-builds the sidecar image in the background) still needs an oracle to ask anything at all.
# Always built rather than `docker image inspect`-guarded: the layer cache makes an unchanged build
# about a second, and a probe image left over from an older lockfile would answer for the wrong code.
( cd "$DIR" && docker build -q -t immich-shared-albums:probe . >/dev/null ) \
  || { echo "!! probe image build failed — the independent oracle cannot run" >&2; exit 1; }
export PROBE_IMAGE=immich-shared-albums:probe

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
# ...but WHAT reads it must not depend on the sidecar's runtime: the Node image has `node`, the Rust
# one does not, and `docker compose exec ... node` then fails with "executable file not found". This
# tiny reader is the language-agnostic path, still a container on the same Docker host, so it shares
# the WAL locks exactly as the in-container reader does.
READER_IMAGE=immich-shared-albums:sqlite-reader
ensure_reader() {
  docker image inspect "$READER_IMAGE" >/dev/null 2>&1 && return 0
  printf 'FROM alpine:3.22\nRUN apk add --no-cache sqlite\n' | docker build -q -t "$READER_IMAGE" - >/dev/null 2>&1
}
sidecar_data_dir() { # the host path behind a sidecar's /data
  local cid; cid=$(docker compose ps -q "$1" 2>/dev/null)
  [ -n "$cid" ] || return 1
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$cid" 2>/dev/null
}
sidecar_col() { # sidecar_col <service> <sql> — run from that household's compose dir
  # -readonly matters: it cannot checkpoint or unlink the WAL, so it is safe even where the locks
  # do not reach (the macOS bind-mount case this comment block exists for).
  # Probe for the runtime rather than trusting an exit code: `docker compose exec` reports a missing
  # binary on STDOUT with status 0, so a fallback keyed on failure never fires and the error text is
  # read as the query's result.
  if docker compose exec -T "$1" sh -c 'command -v node >/dev/null 2>&1' 2>/dev/null; then
    docker compose exec -T "$1" node -e "$SQLITE_COL" "$2" 2>/dev/null
    return 0
  fi
  local src; src=$(sidecar_data_dir "$1") || return 1
  [ -n "$src" ] || return 1
  ensure_reader || return 1
  docker run --rm -v "$src":/data "$READER_IMAGE" sqlite3 -readonly /data/state.db "$2" 2>/dev/null
}

# Built here, once, so the JS lane (demo/e2e/e2e-test.mjs) can rely on it without building it itself.
ensure_reader

purge() { # base key service : delete all albums, sidecar users, non-admin assets (run from the compose dir)
  local BASE=$1 KEY=$2 SVC=${3:-}
  require_mock "$BASE"
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
  # The suite's OWN accounts, which this purge used to leave behind. They are keyed by a per-run
  # suffix, so every run added another "QA Non Admin" and the rig's "no two users share a display
  # name" invariant failed on data rather than on behaviour. Scoped to the rig's own domains, so a
  # real deployment's people are never in reach; the key's owner is skipped, because the suite needs
  # its admin to exist.
  local OWNER=$(curl -s $BASE/api/users/me -H "x-api-key: $KEY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  for U in $(curl -s $BASE/api/admin/users -H "x-api-key: $KEY" | OWNER="$OWNER" python3 -c "import json,os,sys
owner = os.environ.get('OWNER','')
for u in json.load(sys.stdin):
    e = u.get('email','')
    if u['id'] != owner and (e.endswith('@e2e.local') or e.endswith('@demo.local')):
        print(u['id'])" 2>/dev/null); do
    curl -s -X DELETE $BASE/api/admin/users/$U -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"force":true}' -o /dev/null; done
  local IDS=$(curl -s -X POST $BASE/api/search/metadata -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"size":500}' | python3 -c "import json,sys;print(json.dumps([i['id'] for i in json.load(sys.stdin)['assets']['items']]))" 2>/dev/null)
  [ "${IDS:-[]}" != "[]" ] && curl -s -X DELETE $BASE/api/assets -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d "{\"ids\":$IDS,\"force\":true}" -o /dev/null
  # And the notifications every one of those shares produced. Immich writes one per album a person is
  # ADDED to and keeps it after the album is gone, so a rig that has run this suite a few dozen times
  # leaves the mock admin's notification panel holding hundreds of stale rows — which is what a human
  # sees when they open the rig to click through a flow by hand. This is the key owner's OWN
  # notification list (the route is self-only, so nothing else is reachable from here).
  local NIDS=$(curl -s "$BASE/api/notifications?unreadOnly=false" -H "x-api-key: $KEY" | python3 -c "import json,sys;print(json.dumps([n['id'] for n in json.load(sys.stdin)]))" 2>/dev/null)
  [ "${NIDS:-[]}" != "[]" ] && curl -s -X DELETE "$BASE/api/notifications" -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d "{\"ids\":$NIDS}" -o /dev/null
}

# D (third household — relay coverage): a first-time local rig provisions its key here; CI
# writes it beforehand.
cd "$DIR/demo/household-d"
if [ ! -f .env ]; then
  docker compose up -d immich-d db-d redis-d >/dev/null 2>&1
  echo "D_API_KEY=$("$DIR/demo/ci/provision-mock.sh" "http://localhost:$PORT_IMMICH_D" "Demo Dave")" > .env
fi
DKEY=$(grep -m1 "^D_API_KEY=" .env | cut -d= -f2-)

# Bring the household's Immich up with the CURRENT address map (a no-op when nothing changed;
# compose recreates it when the map moved), redeploy the sidecar, purge the Immich, reset the
# sidecar's state — in a subshell so the cd is contained (purge and the state reads run from the
# compose dir). Compose output is kept, prefixed per household: a redeploy that fails here used to
# be invisible, and the run then died later with a message about something else.
redeploy() { # redeploy <compose-dir> <letter> <immich-port> <admin-key>
  (
    cd "$1" && docker compose up -d "immich-$2" "db-$2" "redis-$2" 2>&1 | grep -vE "Running|Started|Created" | sed "s/^/  [immich-$2] /"
    # A moved port map recreates the Immich; purging a booting Immich silently deletes nothing.
    for i in $(seq 1 90); do curl -sf "http://localhost:$3/api/server/ping" >/dev/null && break; sleep 1; done
    curl -sf "http://localhost:$3/api/server/ping" >/dev/null || { echo "  !! immich-$2 on :$3 did not answer within 90s" >&2; exit 1; }
    # The key in .env must belong to THIS Immich. A fresh data directory (a new checkout, a moved
    # rig) means a fresh Immich with no admin, and every later failure would read as a product bug.
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $4" "http://localhost:$3/api/users/me")
    [ "$code" = "200" ] || { echo "  !! the admin key for immich-$2 (:$3) is not valid there (HTTP $code) — re-provision it: demo/ci/provision-mock.sh http://localhost:$3 <name> [--scoped]" >&2; exit 1; }
    if [ -n "$RIG_MOCKS_ONLY" ]; then
      # The sidecars are about to be INSTALLED instead (`deploy/install.sh`), and two sidecars on one
      # Immich fight over the same bot account. Stopped, not removed: the hooks that own them stay.
      docker compose stop "sidecar-$2" >/dev/null 2>&1 || true
      # No sidecar means no contributor keys to enumerate, but the bot accounts go by email domain
      # and `force: true` takes their albums and their assets with them.
      purge "http://localhost:$3" "$4" ""
      echo "  [sidecar-$2] stopped — the mock is the rig's, the sidecar is installed separately"
      return 0
    fi
    docker compose up -d --force-recreate "sidecar-$2" 2>&1 | sed "s/^/  [sidecar-$2] /"
    purge "http://localhost:$3" "$4" "sidecar-$2"
    reset_state "$1" "sidecar-$2"
  )
}
# The three households are independent stacks on separate ports and separate compose projects,
# so they redeploy at once: the wall is the slowest one, not the sum.
echo "== redeploy + purge B, C, D (in parallel) =="
redeploy "$DIR/demo" b "$PORT_IMMICH_B" "$BKEY" &
redeploy "$DIR/demo/household-c" c "$PORT_IMMICH_C" "$CKEY" &
redeploy "$DIR/demo/household-d" d "$PORT_IMMICH_D" "$DKEY" &
wait
# The reset restarts each sidecar from nothing; the preflight below reads a state.db a booting
# sidecar may not have created yet. The sidecar opens its store at import, before it listens, so
# "health answers" is also "that file exists" — wait on that, bounded, rather than on a sleep.
# On failure, say what the containers were actually doing instead of guessing later.
# MOCKS_ONLY deliberately leaves them down, so neither this nor the preflight applies.
if [ -z "$RIG_MOCKS_ONLY" ]; then
for pair in "$PORT_SIDECAR_B:$DIR/demo:sidecar-b" "$PORT_SIDECAR_C:$DIR/demo/household-c:sidecar-c" "$PORT_SIDECAR_D:$DIR/demo/household-d:sidecar-d"; do
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
fi

# Password login is a HAND-test concern: the suite turns it off on C to stand in for a production
# host, which would lock a person out of the very server they came to click through. The browser lane
# re-enables it for its own case for the same reason.
password_login() { # password_login <immich port> <admin key> <True|False>
  local cfg
  cfg=$(curl -s "http://localhost:$1/api/system-config" -H "x-api-key: $2" | python3 -c "import json,sys; c=json.load(sys.stdin); c['passwordLogin']['enabled']=$3; print(json.dumps(c))")
  curl -s -X PUT "http://localhost:$1/api/system-config" -H "x-api-key: $2" -H 'Content-Type: application/json' -d "$cfg" -o /dev/null -w "  passwordLogin enabled=$3: %{http_code}\n"
}

if [ -n "$RIG_MOCKS_ONLY" ]; then
  echo "== hand test: mocks only, the rig's own sidecars stopped (RIG_MOCKS_ONLY) =="
  password_login "$PORT_IMMICH_C" "$CKEY" True
  cat <<EOF

  Two mock Immichs are up and purged. The rig's own sidecars are STOPPED, so the sidecar you
  install with deploy/install.sh is the only one managing each library. Feed the installer:

    B: network household-b_default   URL http://immich-b:2283   key \$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)
    C: network household-c_default   URL http://immich-c:2283   key \$(grep -m1 '^C_API_KEY=' demo/household-c/.env | cut -d= -f2-)

  Immich itself stays on the loopback map: B http://localhost:$PORT_IMMICH_B, C http://localhost:$PORT_IMMICH_C.
  A later run of this script purges both and puts the rig's own sidecars back.
EOF
  exit 0
fi

# Up-only wants it the other way round, below — a tester has to be able to sign in.
if [ -z "$RIG_UP_ONLY" ]; then
  echo "== harden C like production (passwordLogin off) =="
  password_login "$PORT_IMMICH_C" "$CKEY" False
fi

if [ -n "$RIG_UP_ONLY" ]; then
  echo "== hand test: password login ON on C (RIG_UP_ONLY) =="
  password_login "$PORT_IMMICH_C" "$CKEY" True
  # Bound beyond loopback means the tester is on another device: hand out an address it can reach.
  HAND_HOST=${ISA_HAND_TEST_HOST:-}
  if [ -z "$HAND_HOST" ] && [ "$RIG_BIND" != "127.0.0.1" ]; then
    HAND_HOST=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  fi
  echo "== hand test: seeding two linked households =="
  # Addresses the SEEDER uses follow the port map. The seeder makes no destructive call beyond
  # replacing the albums it seeds by name: the guarded purge above is the reset.
  ISA_HAND_TEST_HOST=${HAND_HOST:-localhost} \
  PORT_IMMICH_B=$PORT_IMMICH_B PORT_IMMICH_C=$PORT_IMMICH_C \
  PORT_SIDECAR_B=$PORT_SIDECAR_B PORT_SIDECAR_C=$PORT_SIDECAR_C \
  BKEY=$BKEY CKEY=$CKEY \
  ISA_HAND_TEST_EMAIL=${ISA_HAND_TEST_EMAIL:-admin@e2e.local} \
  ISA_HAND_TEST_PASSWORD=${ISA_HAND_TEST_PASSWORD:-e2e-admin-pass-1} \
  node "$DIR/demo/hand-test-seed.mjs"
  exit $?
fi

echo "== E2E (C origin -> B joiner) =="
cd "$DIR/demo/e2e"
# Addresses the SUITE uses from this host follow the port map. Addresses a SIDECAR is told to
# fetch (ORIGIN_SIDECAR, REVERSE_ORIGIN) are container names on the shared network, so they hold
# whatever the host ports are and however they are bound.
A_URL="http://localhost:$PORT_IMMICH_C" AKEY=$CKEY A_ALBUM=__CREATE__ \
B_URL="http://localhost:$PORT_IMMICH_B" BKEY=$BKEY B_SIDECAR="http://localhost:$PORT_SIDECAR_B" \
B_SIDECAR_API_KEY=${B_SIDECAR_API_KEY:-} \
C_SIDECAR="http://localhost:$PORT_SIDECAR_C" \
D_URL="http://localhost:$PORT_IMMICH_D" DKEY=$DKEY D_SIDECAR="http://localhost:$PORT_SIDECAR_D" \
ORIGIN_SIDECAR=${ORIGIN_SIDECAR:-http://$RIG_PROJECT_C-sidecar-c-1:8300} \
ORIGIN_SIDECAR_DIRECT=${ORIGIN_SIDECAR_DIRECT:-http://localhost:$PORT_SIDECAR_C} \
REVERSE_ORIGIN=${REVERSE_ORIGIN:-http://$RIG_PROJECT_B-sidecar-b-1:8300} \
node e2e-test.mjs
