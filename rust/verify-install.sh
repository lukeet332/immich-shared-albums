#!/usr/bin/env bash
# verify-install.sh — run deploy/install.sh END TO END and check what it actually produced.
#
#   bash rust/verify-install.sh [DOCKERFILE]      # default rust/Dockerfile
#
# install.sh is the thing an operator runs, so testing it means running it: through the prompts,
# through the build, through `docker compose up`, and through its own health check. A sidecar that
# boots but is unreachable from the machine that installed it has not been installed.
#
# It installs against mock household B on a throwaway port and removes everything afterwards. The
# install directory is temporary and the volume is the compose project's own, so nothing that
# exists beforehand is touched.
set -euo pipefail
cd "$(dirname "$0")/.."

DOCKERFILE="${1:-rust/Dockerfile}"
INSTALL_DIR=/tmp/isa-install-check
HOST_PORT=8390
NET=household-b_default
RIG_ENV=demo/.env

fail() { echo "FAIL: $1"; exit 1; }

[ -f "$RIG_ENV" ] || fail "no $RIG_ENV — run demo/run-mock-e2e.sh first"
API_KEY=$(grep -m1 '^B_API_KEY=' "$RIG_ENV" | cut -d= -f2-)
[ -n "$API_KEY" ] || fail "no B_API_KEY in $RIG_ENV"
docker network inspect "$NET" >/dev/null 2>&1 || fail "no $NET network — is the rig up?"

cleanup() {
  (cd "$INSTALL_DIR" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true
  rm -rf "$INSTALL_DIR"
  docker rmi immich-shared-albums:live >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# The prompts, in order: network, immich url, household name, host port, API key, reverse proxy,
# public-proxy, install dir. Answering them is the point — this is the operator's path.
answers=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$NET" "http://immich-b:2283" "Install check" "$HOST_PORT" "$API_KEY" "n" "n" "$INSTALL_DIR")

echo "running deploy/install.sh with $DOCKERFILE"
if ! printf '%s\n' "$answers" | ISA_DOCKERFILE="$DOCKERFILE" bash deploy/install.sh > /tmp/isa-install.log 2>&1; then
  tail -30 /tmp/isa-install.log
  fail "install.sh exited non-zero"
fi
grep -q "health: OK" /tmp/isa-install.log || { tail -30 /tmp/isa-install.log; fail "install.sh did not report healthy"; }
echo "install.sh reported: health OK"

# ---- what it PRODUCED, not what it said ----
[ -f "$INSTALL_DIR/docker-compose.yml" ] || fail "no compose file was written"
grep -q "isa-data:/data" "$INSTALL_DIR/docker-compose.yml" || fail "the identity volume is not mounted"
grep -q "name: $NET" "$INSTALL_DIR/docker-compose.yml" || fail "the detected Immich network was not used"

# The key must be in a 600 env file beside the compose, never inside the yml.
grep -q "ISA_IMMICH_API_KEY" "$INSTALL_DIR/docker-compose.yml" || fail "the compose does not pass the key"
if grep -q "$API_KEY" "$INSTALL_DIR/docker-compose.yml"; then fail "the API KEY IS IN THE COMPOSE FILE"; fi
PERMS=$(stat -c '%a' "$INSTALL_DIR/.env")
[ "$PERMS" = "600" ] || fail ".env is mode $PERMS, expected 600"
echo "key is in a 600 .env, not the compose"

# ---- and the running container it left behind ----
CID=$(cd "$INSTALL_DIR" && docker compose ps -q immich-shared-albums)
[ -n "$CID" ] || fail "no container is running"
[ "$(docker inspect -f '{{.State.Running}}' "$CID")" = "true" ] || fail "the container is not running"

# The operator's OWN entry point: the host port they were prompted for.
curl -fsS "http://127.0.0.1:$HOST_PORT/immich-shared-albums/health" | grep -q '"ok":true' \
  || fail "the health endpoint is not reachable on the host port"
echo "reachable on the prompted host port $HOST_PORT"

# install.sh's own probe runs wget INSIDE the container, which the image must provide.
docker compose -f "$INSTALL_DIR/docker-compose.yml" exec -T immich-shared-albums \
  wget -qO- http://localhost:8300/immich-shared-albums/health | grep -q '"ok":true' \
  || fail "the in-container wget probe (install.sh) failed"

# uid 1000, and the identity volume it owns — the contract the compose comments promise.
UID_INSIDE=$(docker exec "$CID" id -u)
[ "$UID_INSIDE" = "1000" ] || fail "container runs as uid $UID_INSIDE, expected 1000"
docker exec "$CID" test -w /data || fail "/data is not writable by the container's user"
echo "uid 1000 and a writable /data"

# An operator's next step is opening the panel, so it has to answer.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HOST_PORT/immich-shared-albums/admin")
case "$CODE" in 401|403) ;; *) fail "the admin panel answered $CODE, expected 401/403 when signed out";; esac
echo "panel answers $CODE when signed out (the sign-in page)"

# Immich itself must still work with the sidecar in front of it.
curl -fsS -o /dev/null "http://127.0.0.1:$HOST_PORT/auth/login" || fail "Immich is not reachable through the sidecar"
echo "Immich passes through the sidecar"

echo "PASS — install.sh installed $DOCKERFILE end to end"
