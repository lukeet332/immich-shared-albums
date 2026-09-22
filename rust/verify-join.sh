#!/usr/bin/env bash
# verify-join.sh — the MEMBER side of the isa/2 handshake, against a real origin over iroh.
#
#   bash rust/verify-join.sh
#
# Everything else in the suite drives the origin's handlers. This drives the OTHER half: a Rust
# member dialling an origin it has never met, redeeming a share link, and pinning what answered.
# The identity check is the part worth proving — an invite names a public key, and a join that
# accepted an answer from anyone else would hand a person an album belonging to a stranger.
set -uo pipefail
cd "$(dirname "$0")/.."

ORIGIN_PORT=9450
ORIGIN_P2P=9451
ORIGIN_DIR=/tmp/isa-join-origin
PROBE_DIR=/tmp/isa-join-probe
# The rig's host port map (PORT_IMMICH_B), defaulting to the compose default of 2284.
IMG="http://localhost:${PORT_IMMICH_B:-2284}"
RIG_ENV=demo/.env
BKEY=$(grep -m1 '^B_API_KEY=' "$RIG_ENV" | cut -d= -f2-)
[ -n "$BKEY" ] || { echo "no B_API_KEY in $RIG_ENV"; exit 1; }

export PATH=/usr/local/cargo/bin:$PATH
export RUSTUP_HOME=/usr/local/rustup CARGO_HOME="$PWD/rust/.cargo-home"

fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 — $2"; else echo "  FAIL $1 — got $2, expected $3"; fails=$((fails+1)); fi; }
contains() { if printf '%s' "$2" | grep -q "$3"; then echo "  ok   $1"; else echo "  FAIL $1 — $2"; fails=$((fails+1)); fi; }

cleanup() { [ -n "${ORIGIN_PID:-}" ] && kill "$ORIGIN_PID" 2>/dev/null; pkill -x isa 2>/dev/null; }
trap cleanup EXIT
cleanup

# ---- a real album with a real photo, shared by a link ----
ALBUM=$(curl -s -X POST "$IMG/api/albums" -H "x-api-key: $BKEY" -H 'Content-Type: application/json' \
  -d "{\"albumName\":\"Join verify $RANDOM\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
LINK=$(curl -s -X POST "$IMG/api/shared-links" -H "x-api-key: $BKEY" -H 'Content-Type: application/json' \
  -d "{\"type\":\"ALBUM\",\"albumId\":\"$ALBUM\",\"allowUpload\":true}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
[ -n "$ALBUM" ] && [ -n "$LINK" ] || { echo "could not seed an album and a share link"; exit 1; }
echo "origin album $ALBUM, share link ${LINK:0:10}…"

# ---- the origin sidecar, exactly as a household would run it ----
rm -rf "$ORIGIN_DIR"
ISA_IMMICH_API_KEY="$BKEY" ISA_IMMICH_URL="$IMG" ISA_DATA_DIR="$ORIGIN_DIR" \
  ISA_HOUSEHOLD_NAME="Join Origin" ISA_PORT=$ORIGIN_PORT ISA_P2P_PORT=$ORIGIN_P2P ISA_RELAY=off \
  ./rust/target/debug/isa > /tmp/isa-join-origin.log 2>&1 &
ORIGIN_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$ORIGIN_PORT/immich-shared-albums/health" >/dev/null 2>&1 && break; sleep 1; done

# The invite a person would paste: the endpoint token off the share page, plus the key.
TOKEN=$(curl -s "http://127.0.0.1:$ORIGIN_PORT/share/$LINK" \
  | grep -o 'data-origin-endpoint="[^"]*"' | sed 's/.*="//;s/"//')
[ -n "$TOKEN" ] || { echo "the share page carried no endpoint token"; exit 1; }
echo "invite carries an endpoint token (${#TOKEN} chars)"

probe() { # probe <token> <key> [password]
  rm -rf "$PROBE_DIR"
  ISA_IMMICH_API_KEY="$BKEY" ISA_IMMICH_URL="$IMG" ISA_DATA_DIR="$PROBE_DIR" \
    ISA_HOUSEHOLD_NAME="Join Member" ISA_PORT=9452 ISA_P2P_PORT=9453 ISA_RELAY=off \
    timeout 120 ./rust/target/debug/examples/redeem_probe "$1" "$2" "${3:-}" 2>/dev/null | tail -1
}

# ---- a wrong key is refused, and in OUR words ----
OUT=$(probe "$TOKEN" "not-a-real-share-key")
contains "an unknown share key is refused" "$OUT" '"ok":false'
contains "and the refusal is worded by US, not the peer" "$OUT" 'does not recognise this share link'
contains "a refused join pins NO peer" "$OUT" '"pinnedPeers":0'

# ---- the real redeem ----
OUT=$(probe "$TOKEN" "$LINK")
contains "the join succeeds" "$OUT" '"ok":true'
contains "and names the origin household" "$OUT" 'Join Origin'
contains "and the album" "$OUT" "$ALBUM"
contains "and the member PINNED the origin" "$OUT" '"pinnedPeers":1'

# ---- the origin's side of the same handshake: it must have enrolled us ----
# Asked over the origin's OWN HTTP surface rather than by reading its state.db: the database is a
# bind-mount on the DOCKER HOST, so a container started from here cannot see this one's /tmp, and
# the product's own route is the more honest witness anyway.
ORIGIN_PEERS=$(curl -s -H "x-api-key: $BKEY" "http://127.0.0.1:$ORIGIN_PORT/immich-shared-albums/peers")
contains "the ORIGIN enrolled exactly one peer" "$ORIGIN_PEERS" '"name":"Join Member"'
COUNT=$(printf '%s' "$ORIGIN_PEERS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("peers",[])))' 2>/dev/null)
check "and only one — a re-dial must not enrol twice" "${COUNT:-none}" "1"

# ---- the password path, which is a PROMPT rather than an error ----
# A separate origin, because the requirement is a boot setting and the panel branches on the
# distinction: "needs a password" must be distinguishable from "that password is wrong", or the
# person is shown an error where they should be shown a field.
kill "$ORIGIN_PID" 2>/dev/null; sleep 1
rm -rf "$ORIGIN_DIR"
ISA_IMMICH_API_KEY="$BKEY" ISA_IMMICH_URL="$IMG" ISA_DATA_DIR="$ORIGIN_DIR" \
  ISA_HOUSEHOLD_NAME="Join Origin" ISA_PORT=$ORIGIN_PORT ISA_P2P_PORT=$ORIGIN_P2P ISA_RELAY=off \
  ISA_LINK_JOIN_REQUIRES_PASSWORD=true \
  ./rust/target/debug/isa > /tmp/isa-join-origin2.log 2>&1 &
ORIGIN_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$ORIGIN_PORT/immich-shared-albums/health" >/dev/null 2>&1 && break; sleep 1; done
TOKEN2=$(curl -s "http://127.0.0.1:$ORIGIN_PORT/share/$LINK" \
  | grep -o 'data-origin-endpoint="[^"]*"' | sed 's/.*="//;s/"//')
[ -n "$TOKEN2" ] || { echo "the password-gated origin served no token"; exit 1; }

OUT=$(probe "$TOKEN2" "$LINK")
contains "a password-gated album refuses a passwordless join" "$OUT" '"ok":false'
contains "and asks for a PASSWORD, not an error" "$OUT" '"passwordRequired":true'
contains "in our words" "$OUT" 'needs its share password'

[ "$fails" = "0" ] && echo "PASS — the member half of the handshake holds" || { echo "$fails check(s) failed"; exit 1; }
