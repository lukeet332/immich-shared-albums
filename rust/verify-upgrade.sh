#!/usr/bin/env bash
# verify-upgrade.sh — boot the RUST build on state.db a NODE sidecar wrote, and prove it took over.
#
#   bash rust/verify-upgrade.sh
#
# An upgrade is not "the schema is the same". A running install holds an ed25519 identity that every
# linked peer knows as an endpoint id, plus the peers, mappings, ledger rows and contributor keys that
# describe what is shared. If a Rust build cannot READ those, it mints a fresh identity and every link
# is orphaned — which looks like "the other household disappeared", not like a version mismatch.
#
# What this does, on the live rig:
#   1. drives the NODE sidecar to a populated state (join an album over a share link, wait for the
#      mirror's stub to materialise: a mapping, a ledger row with an origin, a contributor with a key)
#   2. stops it cleanly and copies the state into the WORKSPACE
#   3. boots the RUST image on that copy and checks: same identity, the peers are read back, the
#      mapping is live, the ledger row's stub streams BYTE-IDENTICAL from its owner, and the store's
#      own compat test parses the database
#
# PATHS: the copy lives under rust/target/ because /tmp is NOT shared with the Docker daemon — a
# state.db "copied to /tmp" from a container lands somewhere this shell cannot see, and the check then
# reports an empty database for a reason that has nothing to do with the state.
#
# Needs the rig up with the NODE image as B's sidecar and a Docker network the origin shares
# (`isa-demo`). Leaves B's sidecar running the Rust image; `demo/run-mock-e2e.sh` redeploys either way.
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=immich-shared-albums:rust
NODE_IMAGE=immich-shared-albums:demo
STATE_DIR="$PWD/rust/target/upgrade"
RUNNER=isa-upgrade
# TWO networks, and both are needed: `isa-demo` is where the three sidecars reach EACH OTHER (so the
# byte path can dial the owner), and B's compose network is where `immich-b` lives — a sidecar that
# cannot reach its own Immich answers "sign in required" to every request and looks like an auth bug.
NET=isa-demo
IMMICH_NET=${IMMICH_NET:-household-b_default}
# Deliberately NOT B's published port: if B's sidecar were still up, the bind would fail and every
# check below would silently be asking the wrong sidecar.
SIDECAR_PORT=9391
IMMICH_B=http://localhost:${PORT_IMMICH_B:-2284}
IMMICH_C=http://localhost:${PORT_IMMICH_C:-2285}
BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)
CKEY=$(grep -m1 'C_API_KEY=' demo/household-c/.env | cut -d= -f2-)
PASS=0; FAIL=0
check() { # check <what> <ok> <detail>
  if [ "$2" = "1" ]; then printf '  ok   %s%s\n' "$1" "${3:+ — $3}"; PASS=$((PASS+1));
  else printf '  FAIL %s%s\n' "$1" "${3:+ — $3}"; FAIL=$((FAIL+1)); fi
}

# Leaves the rig as it found it: this lane stops B's sidecar to copy its state, so it must start it
# again — a lane that leaves a household down fails the NEXT lane for reasons that look like a bug.
# ALWAYS leaves B's sidecar UP, whatever it found: the rig's other lanes (and the browser lane) need
# three running households, so a lane that stops one and leaves it down fails the next lane for
# reasons that look like a product bug. `up -d` rather than `start`, which fails on a removed container.
cleanup() {
  docker rm -f "$RUNNER" >/dev/null 2>&1
  (cd demo && docker compose up -d sidecar-b >/dev/null 2>&1) || true
  for _ in $(seq 1 60); do
    curl -fsS "http://localhost:${PORT_SIDECAR_B:-8301}/immich-shared-albums/health" >/dev/null 2>&1 && break
    sleep 1
  done
}
trap cleanup EXIT
cleanup
(cd demo && docker compose start sidecar-b >/dev/null 2>&1) || true
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${PORT_SIDECAR_B:-8301}/immich-shared-albums/health" >/dev/null 2>&1 && break
  sleep 1
done

[ -f demo/.env ] || { echo "no demo/.env — run demo/run-mock-e2e.sh first"; exit 1; }
[ -n "$BKEY" ] && [ -n "$CKEY" ] || { echo "no B/C API key in the rig env"; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "no $IMAGE — build it first"; exit 1; }
docker network inspect "$NET" >/dev/null 2>&1 || { echo "no $NET network — is the rig up?"; exit 1; }

say() { printf '\n== %s ==\n' "$1"; }

say "1. drive the NODE sidecar to a populated state"
# B must be running the NODE image for this to be an upgrade FROM it.
B_IMAGE=$(docker inspect household-b-sidecar-b-1 --format '{{.Config.Image}}' 2>/dev/null)
[ "$B_IMAGE" = "$NODE_IMAGE" ] || { echo "B's sidecar runs $B_IMAGE, not $NODE_IMAGE — run demo/run-mock-e2e.sh (default image) first"; exit 1; }

ALBUM_NAME="upgrade probe $(date +%s)"
ALBUM=$(curl -s -X POST "$IMMICH_C/api/albums" -H "x-api-key: $CKEY" -H 'Content-Type: application/json' \
  -d "{\"albumName\":\"$ALBUM_NAME\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
ASSET=$(curl -s -X POST "$IMMICH_C/api/assets" -H "x-api-key: $CKEY" \
  -F "assetData=@demo/e2e/fixtures/fx2.jpg" -F "deviceAssetId=upgrade-$(date +%s)" -F "deviceId=upgrade-probe" \
  -F "fileCreatedAt=2026-05-02T09:00:00.000Z" -F "fileModifiedAt=2026-05-02T09:00:00.000Z" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X PUT "$IMMICH_C/api/albums/$ALBUM/assets" -H "x-api-key: $CKEY" -H 'Content-Type: application/json' \
  -d "{\"ids\":[\"$ASSET\"]}" -o /dev/null
KEY=$(curl -s -X POST "$IMMICH_C/api/shared-links" -H "x-api-key: $CKEY" -H 'Content-Type: application/json' \
  -d "{\"type\":\"ALBUM\",\"albumId\":\"$ALBUM\",\"allowUpload\":true}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
TOK=$(curl -s "http://localhost:${PORT_SIDECAR_C:-8302}/share/$KEY" | grep -o 'data-origin-endpoint="[^"]*"' | sed 's/.*="//;s/"//')
JOINED=$(curl -s -X POST "http://localhost:${PORT_SIDECAR_B:-8301}/immich-shared-albums/join" -H "x-api-key: $BKEY" \
  -H 'Content-Type: application/json' -d "{\"url\":\"http://localhost:${PORT_SIDECAR_C:-8302}/share/$KEY\",\"invite\":{\"endpointToken\":\"$TOK\",\"key\":\"$KEY\"}}")
MIRROR=$(printf '%s' "$JOINED" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("albumId",""))' 2>/dev/null)
check "the Node sidecar joined the album, so it has a mapping to upgrade" "$([ -n "$MIRROR" ] && echo 1 || echo 0)" "${MIRROR:0:8}"

# The stub is what makes the ledger row (and the byte path) real: wait for it to materialise.
STUB=""
for _ in $(seq 1 60); do
  STUB=$(docker run --rm -v "$PWD/demo/b-sidecar:/data:ro" immich-shared-albums:sqlite-reader \
    sqlite3 /data/state.db "SELECT localAsset FROM seen WHERE originAsset IS NOT NULL LIMIT 1;" 2>/dev/null | tr -d '\r')
  [ -n "$STUB" ] && break
  sleep 2
done
check "the Node sidecar wrote a ledger row with an origin asset" "$([ -n "$STUB" ] && echo 1 || echo 0)" "${STUB:0:8}"

say "2. stop it cleanly and copy the state into the workspace"
(cd demo && docker compose stop sidecar-b >/dev/null 2>&1)
# The previous run's /data was written by the Rust container as root, so this shell cannot remove it.
docker run --rm -v "$STATE_DIR:/d" alpine sh -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null' >/dev/null 2>&1 || true
rm -rf "$STATE_DIR" 2>/dev/null || true
mkdir -p "$STATE_DIR"
docker run --rm -v "$PWD/demo/b-sidecar:/data:ro" -v "$STATE_DIR:/out" alpine \
  sh -c 'cp /data/state.db* /out/ 2>/dev/null; chmod -R a+rwX /out' || true
# CHECKPOINT, so the newest writes are in state.db itself: a copy that still needs WAL recovery
# depends on the reader being able to create the -shm, which is exactly the kind of environment
# difference that makes an upgrade check report an empty database for no reason.
docker run --rm -v "$STATE_DIR:/data" immich-shared-albums:sqlite-reader \
  sh -c 'sqlite3 /data/state.db "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null; chmod -R a+rwX /data' >/dev/null 2>&1
NODE_PUB=$(docker run --rm -v "$STATE_DIR:/data" immich-shared-albums:sqlite-reader \
  sqlite3 /data/state.db "SELECT json_extract(value,'\$.pub') FROM kv WHERE name='identity';" 2>/dev/null | tr -d '\r')
# The mapping THIS run created, read from the database it will be upgraded from — not from the join
# response, which cannot tell us whether the row reached the file that gets copied.
MIRROR=$(docker run --rm -v "$STATE_DIR:/data" immich-shared-albums:sqlite-reader \
  sqlite3 /data/state.db "SELECT albumId FROM mappings WHERE albumName='$ALBUM_NAME' ORDER BY rowid DESC LIMIT 1;" 2>/dev/null | tr -d '\r')
check "the copied state carries the Node-written identity" "$([ -n "$NODE_PUB" ] && echo 1 || echo 0)" "${NODE_PUB:0:12}"

say "3. boot the RUST image on it"
docker run -d --name "$RUNNER" --network "$NET" --user 0:0 \
  -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="$BKEY" \
  -e ISA_HOUSEHOLD_NAME="upgrade probe" -e ISA_RELAY=off -e ISA_TEST_HOOKS=1 \
  -v "$STATE_DIR:/data" -p "127.0.0.1:$SIDECAR_PORT:8300" "$IMAGE" >/dev/null
docker network connect "$IMMICH_NET" "$RUNNER" 2>/dev/null || true
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$SIDECAR_PORT/immich-shared-albums/health" >/dev/null 2>&1 && break; sleep 1; done
RUST_PUB=$(docker logs "$RUNNER" 2>&1 | grep -o 'identity [A-Za-z0-9_-]*' | head -1 | awk '{print $2}')
check "the Rust build took over the SAME identity" "$([ "$RUST_PUB" = "${NODE_PUB:0:${#RUST_PUB}}" ] && echo 1 || echo 0)" "node=${NODE_PUB:0:12} rust=${RUST_PUB:0:12}"

PEERS=$(curl -s "http://127.0.0.1:$SIDECAR_PORT/immich-shared-albums/peers" -H "x-api-key: $BKEY" \
  | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("peers",[])))' 2>/dev/null)
check "it reads the peers the Node sidecar stored" "$([ "${PEERS:-0}" -ge 1 ] && echo 1 || echo 0)" "$PEERS peer(s)"

STATUS=$(curl -s "http://127.0.0.1:$SIDECAR_PORT/immich-shared-albums/sync/status?albumId=$MIRROR" -H "x-api-key: $BKEY")
check "the mapping is live, not re-created" "$(printf '%s' "$STATUS" | grep -q '"dead":false' && echo 1 || echo 0)" "$(printf '%s' "$STATUS" | head -c 60)"

say "4. the ledger row the NODE sidecar wrote streams from its owner"
# The asset to compare against is the row's OWN origin, not the photo this run uploaded: the ledger
# row is the thing being upgraded, and any other asset would make the comparison meaningless.
ORIGIN=$(docker run --rm -v "$STATE_DIR:/data" immich-shared-albums:sqlite-reader \
  sqlite3 /data/state.db "SELECT originAsset FROM seen WHERE localAsset='$STUB' LIMIT 1;" 2>/dev/null | tr -d '\r')
curl -s -D "$STATE_DIR/headers.txt" -o "$STATE_DIR/through-rust.jpg" \
  "http://127.0.0.1:$SIDECAR_PORT/api/assets/$STUB/thumbnail?size=preview" -H "x-api-key: $BKEY"
# A just-uploaded photo has no preview until Immich's job runs, so wait for it: a 404 read as a byte
# mismatch would make this check fail for the one reason that has nothing to do with the upgrade.
for _ in $(seq 1 40); do
  curl -s -o "$STATE_DIR/from-owner.jpg" "$IMMICH_C/api/assets/$ORIGIN/thumbnail?size=preview" -H "x-api-key: $CKEY"
  [ -s "$STATE_DIR/from-owner.jpg" ] && break
  sleep 1
done
CACHE=$(grep -i '^x-cache:' "$STATE_DIR/headers.txt" | tr -d '\r' | awk '{print $2}')
RUST_SUM=$(sha256sum "$STATE_DIR/through-rust.jpg" | cut -d' ' -f1)
OWNER_SUM=$(sha256sum "$STATE_DIR/from-owner.jpg" | cut -d' ' -f1)
check "the stub was served from the OWNER, not as the local placeholder" "$([ "$CACHE" = "MISS" ] || [ "$CACHE" = "HIT" ] && echo 1 || echo 0)" "x-cache=${CACHE:-none}"
check "and the bytes are the owner's, byte for byte" "$([ -n "$RUST_SUM" ] && [ "$RUST_SUM" = "$OWNER_SUM" ] && echo 1 || echo 0)" "${RUST_SUM:0:16}"

say "5. the store's own compatibility test, on the populated database"
( cd rust && ISA_COMPAT_DB="$STATE_DIR" cargo test --lib -- --ignored reads_a_real_node_written_state_db \
    > "$STATE_DIR/compat.log" 2>&1 )
check "reads_a_real_node_written_state_db passes on a POPULATED database" \
  "$(grep -q 'test result: ok. 1 passed' "$STATE_DIR/compat.log" && echo 1 || echo 0)" \
  "$(grep -o 'test result: [a-z]*. [0-9]* passed' "$STATE_DIR/compat.log" | tail -1)"

cleanup
echo
if [ "$FAIL" = "0" ]; then echo "PASS — the Rust build took over a populated Node-written state ($PASS checks)"; exit 0; fi
echo "FAILURES ($FAIL of $((PASS+FAIL)))"; exit 1
