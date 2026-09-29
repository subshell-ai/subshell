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
PORT=31998
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
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

echo "OK: docker-image scenario passed for $IMAGE"
