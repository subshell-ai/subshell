#!/usr/bin/env bash
# Tests the PUBLISHED release the way an operator meets it. NOT part of
# `bun run test:cli`: it reaches the public internet and needs a real
# `server-v*` release to exist, so it is the check to run AFTER a cut rather
# than before one.
#
#   bash scripts/cli-e2e/published-release.sh
#
# What it covers that nothing else can: install-server.sh against a real
# release (its digest check, its version resolution, its handoff), the
# published binary booting and serving its EMBEDDED SPA, and the server lazily
# fetching the agent binary from the node release the first time a node asks
# for one — a path with no local equivalent, since it needs two published
# releases to exist at once.
#
# Steps:
#   1. install-server.sh against the real GitHub release (its first ever run
#      with something to download — there were no releases until today);
#   2. the server it installs boots, hands off, and takes a first admin;
#   3. the node one-liner it serves installs and enrols a node against it.
# Temp dirs, a throwaway HOME, port 31997. Never ~/.config/subshell-server or :3080.
set -uo pipefail
PORT=31997
BASE="http://127.0.0.1:$PORT"
W=$(mktemp -d /tmp/ss-rel-XXXX)
SRVPID=""
cleanup() {
  [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null
  for p in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

export HOME="$W/home"
mkdir -p "$HOME"
export SUBSHELL_SERVER_CONFIG_DIR="$W/srv-config"
export SUBSHELL_SERVER_DATA_DIR="$W/srv-data"
export SUBSHELL_NODE_ARTIFACTS_DIR="$W/artifacts"
mkdir -p "$SUBSHELL_SERVER_CONFIG_DIR" "$SUBSHELL_SERVER_DATA_DIR" "$SUBSHELL_NODE_ARTIFACTS_DIR"
export SUBSHELL_SERVER_PORT=$PORT SUBSHELL_SERVER_HOST=127.0.0.1 SUBSHELL_SERVER_BASE_URL="$BASE"
export SUBSHELL_NO_SERVICE=1

echo "== 1. install-server.sh against the PUBLISHED release"
curl -fsSL https://raw.githubusercontent.com/subshell-ai/subshell/main/install-server.sh -o "$W/install-server.sh" \
  || fail "could not fetch the installer from raw.githubusercontent"
ok "fetched the installer over the public URL the README prints"
bash "$W/install-server.sh" > "$W/install.out" 2>&1 || { cat "$W/install.out"; fail "installer exited non-zero"; }
sed 's/^/     | /' "$W/install.out"
SRV="$HOME/.local/bin/subshell-server"
[ -x "$SRV" ] || fail "server not installed at $SRV"
ok "installed $("$SRV" version)"
grep -q "/setup in a browser to create the admin account" "$W/install.out" || fail "no handoff line"
ok "printed the handoff"

echo "== 2. the installed binary boots and answers"
"$SRV" > "$W/server.log" 2>&1 &
SRVPID=$!
for i in $(seq 1 90); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { tail -20 "$W/server.log"; fail "server never answered"; }
ok "answering on $PORT"
grep -q "No account yet" "$W/server.log" || fail "boot log did not name /setup"
ok "boot log named /setup"
curl -sf "$BASE/" -o /dev/null || fail "embedded SPA not served"
ok "serves its embedded SPA"

echo "== 3. first admin, then a node setup key"
JAR="$W/cookies"
curl -sf -c "$JAR" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery","name":"Admin"}' >/dev/null || fail "sign-up"
curl -s -c "$JAR" -X POST "$BASE/api/auth/sign-in/email" -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery"}' >/dev/null
"$SRV" status 2>&1 | grep -q "admin account exists" || fail "status did not see the admin"
ok "admin created; status agrees"
KEY=$(curl -s -b "$JAR" -X POST "$BASE/api/nodes/setup-keys" -H 'content-type: application/json' \
  -d '{"label":"release-e2e"}' | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
[ -n "$KEY" ] || fail "no setup key"
ok "setup key minted"

echo "== 4. the node one-liner, served by the released server"
export SUBSHELL_CONFIG_HOME="$W/node-config"
mkdir -p "$SUBSHELL_CONFIG_HOME"
curl -fsSL "$BASE/install.sh?setup_key=$KEY" | bash > "$W/node.out" 2>&1 || { cat "$W/node.out"; fail "node installer failed"; }
sed 's/^/     | /' "$W/node.out"
[ -x "$HOME/.local/bin/subshell" ] || fail "agent not installed"
ok "agent installed to ~/.local/bin/subshell"
grep -q "/nodes" "$W/node.out" || fail "node installer never named the nodes page"
ok "named the nodes page"
curl -s -b "$JAR" "$BASE/api/nodes" | grep -q '"kind":"agent"' || fail "node row not created"
ok "node enrolled on the released server"

echo
echo "RELEASE E2E PASSED"
