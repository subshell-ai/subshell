#!/usr/bin/env bash
# Prove a native CLI install accepts its own LAN address without extra origins.
# Run against a compiled server; all config, users and data are temporary.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRV="${1:-$ROOT/apps/server/api/dist/subshell-server}"
LAN_IP="${2:-$(bun -e 'import os from "node:os"; console.log(Object.values(os.networkInterfaces()).flat().find(a => a && a.family === "IPv4" && !a.internal)?.address ?? "")')}"
[ -n "$LAN_IP" ] || { echo "SKIP: no LAN interface for the origin check"; exit 0; }
PORT=31997
BASE="http://127.0.0.1:$PORT"
BROWSER_ORIGIN="http://$LAN_IP:$PORT"
W=$(mktemp -d)
SRVPID=""
cleanup() {
  if [ -n "$SRVPID" ]; then kill "$SRVPID" 2>/dev/null || true; wait "$SRVPID" 2>/dev/null || true; fi
  rm -rf "$W"
}
trap cleanup EXIT
export HOME="$W/home"
export SUBSHELL_SERVER_CONFIG_DIR="$W/config"
export SUBSHELL_SERVER_DATA_DIR="$W/data"
export DATABASE_PATH="$W/data/subshell.db"
export SERVER_PORT="$PORT" HOST=0.0.0.0 TRUSTED_ORIGINS=""
export BETTER_AUTH_SECRET="origin-test-secret-0123456789abcdefghijklmnopqrstuvwxyz"
unset APP_BASE_URL
mkdir -p "$HOME" "$SUBSHELL_SERVER_CONFIG_DIR" "$SUBSHELL_SERVER_DATA_DIR"
# Keep a developer's repository .env out of this boot.
cd "$W"
"$SRV" init --yes --no-service --port "$PORT" --host 0.0.0.0 > "$W/init.log" 2>&1
"$SRV" > "$W/server.log" 2>&1 &
SRVPID=$!
ready=""
for _ in $(seq 1 60); do
  if curl -sf "$BASE/api/setup/status" >/dev/null; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { cat "$W/server.log"; echo 'FAIL: CLI never started'; exit 1; }
status=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Origin: https://unrelated.example.com' \
  -H 'Content-Type: application/json' --data '{"email":"untrusted-check@example.test","password":"origin-check-password-12345","name":"Untrusted check"}' "$BASE/api/auth/sign-up/email")
[ "$status" = 403 ] || { echo "FAIL: unrelated origin returned $status"; exit 1; }
status=$(curl -sS -o "$W/signup.json" -w '%{http_code}' -H "Origin: $BROWSER_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data '{"email":"origin-check@example.test","password":"origin-check-password-12345","name":"Origin check"}' \
  "$BASE/api/auth/sign-up/email")
[ "$status" = 200 ] || { echo "FAIL: CLI LAN signup returned $status"; cat "$W/signup.json"; exit 1; }
curl -sf "$BASE/api/setup/status" | grep -q '"needsSetup":false' || { echo 'FAIL: signup did not finish setup'; exit 1; }
echo "OK: CLI LAN signup at $BROWSER_ORIGIN, unrelated origin refused"
