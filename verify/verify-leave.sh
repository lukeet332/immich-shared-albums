#!/usr/bin/env bash
# verify-leave.sh — prove `leaveAlbum` reclaims the space, against a REAL Immich.
#
# The purge is the part worth proving: a stub is owned by a per-person STAND-IN, and Immich scopes
# reads per credential, so the admin key CANNOT see it — it answers 400 `Not found or no
# asset.read access`, not 404. A purge that treats that as "already gone" reports success and
# deletes nothing, and one that treats it as a hard failure reclaims nothing either.
#
#   bash verify/verify-leave.sh [IMMICH_URL] [DATA_DIR]
#
# Defaults to mock household B. Never point this at a real server: it DELETES an album.
set -euo pipefail
cd "$(dirname "$0")/.."

# The rig's host port map (PORT_IMMICH_B), defaulting to the compose default of 2284.
IMMICH_URL="${1:-http://localhost:${PORT_IMMICH_B:-2284}}"
DATA_DIR="${2:-/tmp/isa-leave}"
RIG_ENV="demo/.env"

[ -f "$RIG_ENV" ] || { echo "no $RIG_ENV — run demo/run-mock-e2e.sh first"; exit 1; }
API_KEY=$(grep -m1 '^B_API_KEY=' "$RIG_ENV" | cut -d= -f2-)
[ -n "$API_KEY" ] || { echo "no B_API_KEY in $RIG_ENV"; exit 1; }

export PATH=/usr/local/cargo/bin:$PATH
export RUSTUP_HOME=/usr/local/rustup CARGO_HOME="$PWD/.cargo-home"
export ISA_IMMICH_API_KEY="$API_KEY" ISA_IMMICH_URL="$IMMICH_URL"
export ISA_DATA_DIR="$DATA_DIR" ISA_HOUSEHOLD_NAME="Leave probe"
export ISA_TEST_HOOKS=1 ISA_PORT=9491 ISA_RELAY=off

# A fresh data dir each run: the probe asserts on ledger counts, so stale rows would lie.
rm -rf "$DATA_DIR"
cargo run -q --manifest-path Cargo.toml --example seed_member >/dev/null
cargo run -q --manifest-path Cargo.toml --example leave_probe > /tmp/isa-leave-out.json 2>/tmp/isa-leave-out.log
tail -1 /tmp/isa-leave-out.json

grep -q '"purged":1' /tmp/isa-leave-out.json || { echo "FAIL: expected exactly 1 stub purged"; exit 1; }
grep -q '"failed":0' /tmp/isa-leave-out.json || { echo "FAIL: a purge reported a failure"; exit 1; }
grep -q '"refused":0' /tmp/isa-leave-out.json || { echo "FAIL: a purge was refused"; exit 1; }
grep -q '"stubReadableBy":\[\]' /tmp/isa-leave-out.json || { echo "FAIL: some credential can still read the stub"; exit 1; }
grep -q '"mappingGone":true' /tmp/isa-leave-out.json || { echo "FAIL: the mapping survived"; exit 1; }
grep -q '"albumStillReadable":false' /tmp/isa-leave-out.json || { echo "FAIL: the mirror album survived"; exit 1; }
echo "PASS — leave purged the stub and took the mirror and the mapping with it"
