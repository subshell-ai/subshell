#!/usr/bin/env bash
#
# The container end-to-end scenario: boots a BUILT Subshell image and asserts
# the container contract from the outside - version, PATH, per-install secret,
# the image-pull update story, and a recreate that keeps config.env
# byte-identical. (spec 2026-09-28 § 8)
#
#   bash scripts/cli-e2e/docker-image.sh ghcr.io/subshell-ai/subshell:1.2.3 [1.2.3]
#
# Takes an image ref (any locally-built tag works too) and optionally the
# version its `version` verb must print. Needs docker and network (the update
# --check hits the release source, and a fresh pull needs GHCR). Deliberately
# NOT wired into run.sh: the suite there builds from source; this one tests a
# finished image. Port 31998 (the 31992-31999 family).
set -euo pipefail
IMAGE="${1:?usage: docker-image.sh <image-ref> [version]}"
EXPECTED_VERSION="${2:-}"
NAME="subshell-e2e-$$"
VOL="subshell-e2e-$$"
HOST_NAME="${NAME}-host"
HOST_VOL="${VOL}-host"
PORT=31998
BROWSER_ORIGIN="http://192.0.2.17:$PORT"
cleanup() { docker rm -f "$NAME" "$HOST_NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" "$HOST_VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker volume create "$VOL" >/dev/null

boot() {
  docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:3080" -v "$VOL:/data" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/api/setup/status" >/dev/null && return 0
    sleep 1
  done
  echo "FAIL: the server never answered /api/setup/status" >&2
  docker logs "$NAME" >&2
  return 1
}

echo "==> boot + readiness"
docker pull "$IMAGE" >/dev/null 2>&1 || true   # a local build has nothing to pull; fine
boot

echo "==> browser origin through a published Docker port"
# The browser sees the host address and published port, which Docker's own
# interfaces cannot discover. Persist that deployment address just as the
# Proxmox helper does, without pinning an environment override on every boot.
docker exec "$NAME" subshell-server configure --yes --base-url "$BROWSER_ORIGIN" >/dev/null
docker rm -f "$NAME" >/dev/null
boot
# Empty signup input cannot create an account. A trusted origin gets a
# validation error; an unrelated origin must still fail the origin gate.
check_signup_origin() {
  local origin="$1" expected="$2" status payload='{}'
  if [ "$expected" = 403 ]; then
    payload='{"email":"untrusted-check@example.test","password":"origin-check-password-12345","name":"Untrusted check"}'
  fi
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data "$payload" "http://127.0.0.1:$PORT/api/auth/sign-up/email")
  [ "$status" = "$expected" ] || { echo "FAIL: signup origin $origin returned $status, expected $expected" >&2; exit 1; }
}
check_signup_origin "$BROWSER_ORIGIN" 400
check_signup_origin "https://unrelated.example.com" 403
status=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Origin: $BROWSER_ORIGIN" -H 'Content-Type: application/json' \
  --data '{"email":"origin-check@example.test","password":"origin-check-password-12345","name":"Origin check"}' \
  "http://127.0.0.1:$PORT/api/auth/sign-up/email")
[ "$status" = 200 ] || { echo "FAIL: Docker signup returned $status" >&2; exit 1; }
curl -sf "http://127.0.0.1:$PORT/api/setup/status" | grep -q '"needsSetup":false' \
  || { echo "FAIL: Docker signup did not finish setup" >&2; exit 1; }

echo "==> version"
VERSION_OUT=$(docker exec "$NAME" subshell-server version)
echo "    $VERSION_OUT"
if [ -n "$EXPECTED_VERSION" ]; then
  [ "$VERSION_OUT" = "subshell-server $EXPECTED_VERSION" ] || { echo "FAIL: expected subshell-server $EXPECTED_VERSION" >&2; exit 1; }
fi

echo "==> tmux + the five harnesses resolve in-container"
docker exec "$NAME" bash -c 'command -v tmux claude codex opencode hermes pi' >/dev/null

echo "==> the update rail names the image as the unit of update"
CHECK_JSON=$(docker exec "$NAME" subshell-server update --check --json || true)
echo "$CHECK_JSON" | grep -q '"containerized":true' || { echo "FAIL: --check did not report containerized: $CHECK_JSON" >&2; exit 1; }

echo "==> secret minted once, stable across a recreate"
SECRET1=$(docker exec "$NAME" sha256sum /data/config.env)
docker rm -f "$NAME" >/dev/null
boot
SECRET2=$(docker exec "$NAME" sha256sum /data/config.env)
# The volume survived the recreate, so config.env must be byte-identical - the
# same secret, not a re-mint one: init's keep-existing branch, verified.
[ "$SECRET1" = "$SECRET2" ] || { echo "FAIL: config.env changed across a container recreate" >&2; exit 1; }
docker exec "$NAME" bash -c 'grep -q "^BETTER_AUTH_SECRET=.\{32,\}" /data/config.env'

if [ "$(uname -s)" = Linux ]; then
  echo "==> automatic LAN signup with Docker host networking"
  host_ip=$(hostname -I | awk '{print $1}')
  [ -n "$host_ip" ] || { echo 'FAIL: no host address for the host networking check' >&2; exit 1; }
  host_port=31996
  host_origin="http://$host_ip:$host_port"
  docker volume create "$HOST_VOL" >/dev/null
  docker run -d --name "$HOST_NAME" --network host \
    -e SERVER_PORT="$host_port" -v "$HOST_VOL:/data" "$IMAGE" >/dev/null
  ready=""
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$host_port/api/setup/status" >/dev/null; then ready=1; break; fi
    sleep 1
  done
  [ -n "$ready" ] || { docker logs "$HOST_NAME" >&2; echo 'FAIL: host network server never started' >&2; exit 1; }
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Origin: $host_origin" -H 'Content-Type: application/json' \
    --data '{"email":"origin-check@example.test","password":"origin-check-password-12345","name":"Origin check"}' \
    "http://127.0.0.1:$host_port/api/auth/sign-up/email")
  [ "$status" = 200 ] || { echo "FAIL: automatic Docker LAN signup returned $status" >&2; exit 1; }
fi

echo "OK: docker-image scenario passed for $IMAGE"
