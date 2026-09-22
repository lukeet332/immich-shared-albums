#!/usr/bin/env bash
# verify-image.sh — prove the Rust image honours the container contract the deploy path depends on.
#
# The contract is not "it starts". install.sh probes the health endpoint with `docker compose exec
# … wget`, compose gates on `condition: service_healthy`, operators bind-mount ./data and expect
# uid 1000 to be able to write it, and linked peers redial a FIXED udp port. Each of those is
# asserted below, because each fails silently in a different way if it regresses.
#
#   bash rust/verify-image.sh [IMAGE]
set -euo pipefail

IMAGE="${1:-immich-shared-albums:rust}"
NAME=isa-image-check
PORT=8399

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

fail() { echo "FAIL: $1"; exit 1; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "$IMAGE is not built"

# A dummy key is enough: /health answers without Immich, which is the point of the probe.
docker run -d --name "$NAME" -e ISA_IMMICH_API_KEY=image-check-key \
  -e ISA_HOUSEHOLD_NAME="Image check" -p "127.0.0.1:$PORT:8300" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/immich-shared-albums/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

HEALTH=$(curl -fsS "http://127.0.0.1:$PORT/immich-shared-albums/health") || fail "health endpoint did not answer"
echo "health: $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || fail "health did not report ok"

# The protocol number is what a join card reads to diagnose version skew.
echo "$HEALTH" | grep -q '"protocol":2' || fail "health did not report protocol 2"
echo "$HEALTH" | grep -q '"ok":true,"protocol"\|"protocol":2' || fail "unexpected health shape"

# install.sh:111 shells this exact command inside the container, so wget must exist.
docker exec "$NAME" wget -qO- "http://127.0.0.1:8300/immich-shared-albums/health" \
  | grep -q '"ok":true' || fail "wget health probe (install.sh:111) failed inside the container"

UID_INSIDE=$(docker exec "$NAME" id -u)
[ "$UID_INSIDE" = "1000" ] || fail "container runs as uid $UID_INSIDE, expected 1000"
echo "uid: $UID_INSIDE"

# A bind-mounted ./data must be writable by the same uid that owns the anonymous volume.
docker exec "$NAME" test -w /data || fail "/data is not writable by uid 1000"
OWNER=$(docker exec "$NAME" stat -c '%u' /data/state.db 2>/dev/null) \
  || fail "state.db was not created in /data"
[ "$OWNER" = "1000" ] || fail "state.db is owned by $OWNER, expected 1000"
echo "state.db owner: $OWNER"

# The peer transport binds a FIXED udp port so a linked server can redial after a restart.
docker logs "$NAME" 2>&1 | grep -q "peer transport listening on udp/" \
  || fail "the peer transport did not report listening"

# compose's `condition: service_healthy` depends on the HEALTHCHECK actually transitioning.
for _ in $(seq 1 60); do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo unknown)
  [ "$STATUS" = "healthy" ] && break
  sleep 1
done
[ "$STATUS" = "healthy" ] || fail "HEALTHCHECK never went healthy (status: $STATUS)"
echo "HEALTHCHECK: $STATUS"

# The identity is the peer's address AND its authentication key, so losing it across a restart
# breaks every link without any error at boot.
BEFORE=$(docker logs "$NAME" 2>&1 | grep -o 'identity [A-Za-z0-9_-]*' | head -1)
docker restart "$NAME" >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/immich-shared-albums/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
AFTER=$(docker logs "$NAME" 2>&1 | grep -o 'identity [A-Za-z0-9_-]*' | tail -1)
[ -n "$BEFORE" ] || fail "no identity was logged at boot"
[ "$BEFORE" = "$AFTER" ] || fail "the identity changed across a restart ($BEFORE -> $AFTER)"
echo "identity survived restart: $BEFORE"

echo "PASS — image contract holds"
