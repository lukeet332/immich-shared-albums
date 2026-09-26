#!/usr/bin/env bash
# bench.sh — measure the Rust port against the TypeScript sidecar it replaces, on the same box,
# against the same mock Immich, with the same work asked of each.
#
#   bash verify/bench.sh
#
# Both run as containers from their own image, so what is compared is the ARTEFACT that ships, not a
# debug binary, built from Dockerfile. Every number is taken the same way: the same curl, the
# same request
# count, the same warm-up.
set -uo pipefail
cd "$(dirname "$0")/.."

NET=household-b_default
BKEY=$(grep -m1 '^B_API_KEY=' demo/.env | cut -d= -f2-)
PORT_NODE=8395
PORT_RUST=8396
N=${N:-300}          # requests per latency measurement
OUT=/tmp/bench-results.txt
: > "$OUT"

docker network inspect "$NET" >/dev/null 2>&1 || { echo "rig is not up — run demo/run-mock-e2e.sh first"; exit 1; }

row() { printf '%-34s %s\n' "$1" "$2" | tee -a "$OUT"; }

start() { # image port name
  docker rm -f "$3" >/dev/null 2>&1
  docker run -d --name "$3" --network "$NET" --user 0:0 \
    -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="$BKEY" \
    -e ISA_HOUSEHOLD_NAME="Bench" -e ISA_RELAY=off \
    -p "127.0.0.1:$2:8300" "$1" >/dev/null
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$2/immich-shared-albums/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FAILED to start $1"; return 1
}
stop() { docker rm -f "$1" >/dev/null 2>&1; }

# ---- image size (the artefact itself) ----
echo "=== image ===" | tee -a "$OUT"
for spec in "immich-shared-albums:rust|Rust|Dockerfile"; do
  img=${spec%%|*}; rest=${spec#*|}; label=${rest%%|*}
  docker image inspect "$img" >/dev/null 2>&1 || { echo "building $img"; docker build -q -t "$img" -f "${rest##*|}" . >/dev/null 2>&1; }
  size=$(docker image inspect "$img" --format '{{.Size}}' 2>/dev/null)
  row "$label image bytes" "${size:-N/A}"
done

# ---- cold start: run -> first healthy answer ----
echo "=== cold start ===" | tee -a "$OUT"
cold() { # image port name label
  docker rm -f "$3" >/dev/null 2>&1
  local t0=$(date +%s.%N)
  docker run -d --name "$3" --network "$NET" --user 0:0 \
    -e ISA_IMMICH_URL=http://immich-b:2283 -e ISA_IMMICH_API_KEY="$BKEY" \
    -e ISA_HOUSEHOLD_NAME="Bench" -e ISA_RELAY=off -p "127.0.0.1:$2:8300" "$1" >/dev/null
  for _ in $(seq 1 600); do
    curl -fsS "http://127.0.0.1:$2/immich-shared-albums/health" >/dev/null 2>&1 && break
    sleep 0.1
  done
  local t1=$(date +%s.%N)
  row "$4 cold start to healthy (s)" "$(python3 -c "print(f'{$t1 - $t0:.3f}')")"
}

# ---- latency: health (no Immich), panel (renders), proxied Immich page (passthrough) ----
latency() { # port label
  local port=$1 label=$2
  for path in "/immich-shared-albums/health" "/immich-shared-albums/assets/panel.js" "/auth/login"; do
    # warm-up, so the first TLS/TCP setup is not the measurement
    for _ in $(seq 1 10); do curl -s -o /dev/null "http://127.0.0.1:$port$path"; done
    local t0=$(date +%s.%N)
    for _ in $(seq 1 "$N"); do curl -s -o /dev/null "http://127.0.0.1:$port$path"; done
    local t1=$(date +%s.%N)
    row "$label ${path} mean ms" "$(python3 -c "print(f'{($t1 - $t0) * 1000 / $N:.3f}')")"
  done
}

# ---- memory: idle, and after the same 300-request load ----
mem() { # name label
  local rss
  rss=$(docker exec "$1" sh -c 'grep VmRSS /proc/1/status' 2>/dev/null | awk '{print $2}')
  echo "${rss:-0}"
}

echo "=== measuring ===" | tee -a "$OUT"
cold immich-shared-albums:node "$PORT_NODE" bench-node Node
NODE_IDLE=$(mem bench-node)
latency "$PORT_NODE" Node
NODE_LOAD=$(mem bench-node)
row "Node RSS idle KB" "$NODE_IDLE"
row "Node RSS after $N requests KB" "$NODE_LOAD"
row "Node threads" "$(docker exec bench-node sh -c 'ls /proc/1/task | wc -l' 2>/dev/null)"

cold immich-shared-albums:rust "$PORT_RUST" bench-rust Rust
RUST_IDLE=$(mem bench-rust)
latency "$PORT_RUST" Rust
RUST_LOAD=$(mem bench-rust)
row "Rust RSS idle KB" "$RUST_IDLE"
row "Rust RSS after $N requests KB" "$RUST_LOAD"
row "Rust threads" "$(docker exec bench-rust sh -c 'ls /proc/1/task | wc -l' 2>/dev/null)"

stop bench-node; stop bench-rust
echo; echo "results written to $OUT"
