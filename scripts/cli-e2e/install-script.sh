#!/usr/bin/env bash
# Drives the SERVER-RENDERED node installer exactly as an operator would:
# curl .../install.sh?setup_key=... | bash, against a local stack on 31998.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRV="$ROOT/apps/server/api/dist/subshell-server"
PORT=31998
BASE="http://127.0.0.1:$PORT"
W=$(mktemp -d /tmp/ss-inst-XXXX)
SRVPID=""
cleanup() {
  [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null
  for p in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

export SUBSHELL_SERVER_CONFIG_DIR="$W/srv-config"
export SUBSHELL_SERVER_DATA_DIR="$W/srv-data"
export SUBSHELL_NODE_ARTIFACTS_DIR="$W/artifacts"
export SUBSHELL_NODE_RELEASE_URL=""      # no internet fallback: prove OUR artifact is used
mkdir -p "$SUBSHELL_SERVER_CONFIG_DIR" "$SUBSHELL_SERVER_DATA_DIR" "$SUBSHELL_NODE_ARTIFACTS_DIR"

echo "== publish the locally compiled agent as this instance's artifact"
TRIPLE="darwin-arm64"
cp "$ROOT/apps/node/agent/dist/subshell" "$SUBSHELL_NODE_ARTIFACTS_DIR/subshell-node-cli-$TRIPLE"
shasum -a 256 "$SUBSHELL_NODE_ARTIFACTS_DIR/subshell-node-cli-$TRIPLE" | awk '{print $1}' \
  > "$SUBSHELL_NODE_ARTIFACTS_DIR/subshell-node-cli-$TRIPLE.sha256"
ok "published subshell-node-cli-$TRIPLE + bare-hex sidecar"

"$SRV" init --yes --no-service --port $PORT --host 127.0.0.1 --base-url "$BASE" >/dev/null 2>&1 || fail "init"
"$SRV" > "$W/server.log" 2>&1 &
SRVPID=$!
for i in $(seq 1 60); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/server.log"; fail "server never answered"; }
ok "server up on $PORT"

JAR="$W/cookies"
curl -sf -c "$JAR" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery","name":"Admin"}' >/dev/null || fail "sign-up"
curl -s -c "$JAR" -X POST "$BASE/api/auth/sign-in/email" -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery"}' >/dev/null
KEY=$(curl -s -b "$JAR" -X POST "$BASE/api/nodes/setup-keys" -H 'content-type: application/json' \
  -d '{"label":"e2e"}' | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
[ -n "$KEY" ] || fail "no setup key"
ok "admin + setup key ready"

echo "== the one-liner, as an operator runs it"
export HOME="$W/fakehome"
export SUBSHELL_CONFIG_HOME="$W/fakehome/.config/subshell"
export SUBSHELL_NO_SERVICE=1
mkdir -p "$HOME"
set +e
curl -fsSL "$BASE/install.sh?setup_key=$KEY" | bash > "$W/install.out" 2>&1
RC=$?
set -e
cat "$W/install.out"
[ $RC -eq 0 ] || fail "installer exited $RC"

[ -x "$HOME/.local/bin/subshell" ] || fail "agent not installed at ~/.local/bin/subshell"
ok "installed to \$HOME/.local/bin/subshell (not the curl CWD)"
grep -qE ": OK|verifying" "$W/install.out" || fail "no checksum step"
ok "verified the digest"
grep -qi 'start the agent with' "$W/install.out" && fail "still ends at the foreground run"
ok "does not end at a foreground \`subshell run\`"
grep -q "/nodes" "$W/install.out" || fail "never named the nodes page"
ok "named the nodes page as the next step"
curl -s -b "$JAR" "$BASE/api/nodes" | grep -q '"kind":"agent"' || fail "node row never created"
ok "the node is enrolled on the control plane"

echo
echo "INSTALL.SH E2E PASSED"
