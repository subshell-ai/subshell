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
export SUBSHELL_RELEASE_URL=""      # no internet fallback: prove OUR artifact is used
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
# No body: the mint names nothing since the node-setup revamp — a node is named
# by the machine that becomes it. `-d '{}'` would work too, and would hide the fact
# that the endpoint takes nothing.
KEY=$(curl -s -b "$JAR" -X POST "$BASE/api/nodes/setup-keys" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
[ -n "$KEY" ] || fail "no setup key"
ok "admin + setup key ready"

echo "== the one-liner, as an operator runs it"
export HOME="$W/fakehome"
export SUBSHELL_CONFIG_HOME="$W/fakehome/.config/subshell"
export SUBSHELL_NO_SERVICE=1
mkdir -p "$HOME"

# FIRST the nameless pipe, which is the case this revamp made impossible: there is
# no terminal to ask and no name in the command, so `setup` refuses. It must refuse
# as a usage error (2), say what to do about it, and — the part only a compiled run
# can prove — leave the single-use key UNSPENT, because the refusal happens before
# any network call. Everything below then runs with the name supplied and redeems
# the very same key.
set +e
curl -fsSL "$BASE/install.sh?setup_key=$KEY" | bash > "$W/nameless.out" 2>&1
RC=$?
set -e
cat "$W/nameless.out"
[ "$RC" -eq 2 ] || fail "a nameless piped install exited $RC, expected the usage error 2"
grep -q -- '--name <n>' "$W/nameless.out" || fail "the refusal does not name --name"
grep -q "SUBSHELL_NODE_NAME" "$W/nameless.out" || fail "the refusal does not name the pipe's own knob"
ok "a nameless one-liner refuses with the usage error, naming both fixes"

# The key is still redeemable: the control plane has never seen this attempt.
curl -s -b "$JAR" "$BASE/api/nodes/setup-keys" | grep -q '"usedAt":null' || fail "the nameless attempt spent the key"
ok "the spent-by-nobody key is still unused"

set +e
# The assignment sits on the BASH side on purpose: `VAR=… curl … | bash` would
# export it to curl, which has no use for it, and the installer would run nameless.
curl -fsSL "$BASE/install.sh?setup_key=$KEY" | SUBSHELL_NODE_NAME="e2e one-liner" bash > "$W/install.out" 2>&1
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

# The name crossed the pipe as ONE value: had the script expanded
# $SUBSHELL_NODE_NAME unquoted, the plane would hold "e2e" and the agent would have
# treated "one-liner" as a stray argument.
curl -s -b "$JAR" "$BASE/api/nodes" | grep -q '"name":"e2e one-liner"' \
  || fail "SUBSHELL_NODE_NAME did not reach the node row intact"
ok "SUBSHELL_NODE_NAME named the node, spaces intact"

echo
echo "INSTALL.SH E2E PASSED"
