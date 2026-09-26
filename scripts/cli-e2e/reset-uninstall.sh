#!/usr/bin/env bash
# Issue #232: `subshell-server reset` and `uninstall` COMPILED — the refusal
# shapes (--yes cannot buy consent, headless names --confirm, a wrong name
# changes nothing, a hand-started daemon answering the port ends the chain
# before any byte goes) and the real deletes, against a sandbox config/data
# home and a COPIED binary. The copy matters: `uninstall` deletes the binary
# the resolution ladder names, and run-under-`subshell-server` makes that the
# running process's own file — which is correct behavior and also would
# remove the shared dist binary every later scenario reads.
#
# Never touches the operator's machine: HOME, config, data and TMUX_TMPDIR are
# temp dirs (the service-definition lookup therefore finds nothing under the
# fake HOME, and the pane sweep cannot reach a real instance's tmux servers),
# no service is ever installed, and the port is 31996.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRV_SRC="$ROOT/apps/server/api/dist/subshell-server"
PORT=31996
BASE="http://127.0.0.1:$PORT"
W=$(mktemp -d /tmp/ss-reset-e2e-XXXX)
# Bun auto-loads a .env from the CWD and every scenario runs at the repo root:
# pin every key the live instance's .env could carry (see the long note in
# headless-server-and-node.sh — same trap, same rule: process env beats .env).
export APP_BASE_URL="$BASE"
export BETTER_AUTH_SECRET="cli-e2e-sandbox-secret-not-a-real-one-0123456789ab"
export SERVER_PORT="$PORT"
export HOST=127.0.0.1
export TRUSTED_ORIGINS=""
export SUBSHELL_SERVER_CONFIG_DIR="$W/srv-config"
export SUBSHELL_SERVER_DATA_DIR="$W/srv-data"
# The db path is a config.env key too: pin it to where serverPaths() puts it,
# else a stray DATABASE_PATH in the repo-root .env would send the server's DB
# somewhere the reset never looks and the scenario's file checks would lie.
export DATABASE_PATH="$W/srv-data/subshell.db"
export HOME="$W/home"
# reset sweeps tmux servers named subshell-* under (TMUX_TMPDIR ?? /tmp).
# Without the pin, running this scenario on a developer's own machine would
# kill the pane servers of their REAL instance. Under the pin the sweep sees
# an empty (nonexistent) temp dir and passes, which is what the sandbox wants.
export TMUX_TMPDIR="$W/tmux"
mkdir -p "$HOME" "$SUBSHELL_SERVER_CONFIG_DIR" "$SUBSHELL_SERVER_DATA_DIR"
SRVPID=""
cleanup() {
  [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null
  # The lsof sweep is a belt for an orphaned step-4 daemon; on a host without
  # lsof an orphan would hold the port and the later step fails loudly on the
  # chain's own port guard rather than deleting under a survivor.
  for p in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  rm -rf "$W"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }
HOSTNAME_VAL="$(hostname)"
# The compiled binary runs as a COPY so `uninstall` may delete itself.
SRV="$W/subshell-server"
cp "$SRV_SRC" "$SRV"

echo "== 1. refusal shapes cost nothing"
OUT=$("$SRV" reset --yes 2>&1) && fail "reset --yes exited 0"
echo "$OUT" | grep -q -- "--yes cannot confirm a reset" || fail "reset --yes refused without naming itself: $OUT"
OUT=$("$SRV" uninstall --yes 2>&1) && fail "uninstall --yes exited 0"
echo "$OUT" | grep -q -- "--yes cannot confirm an uninstall" || fail "uninstall --yes refused wrongly: $OUT"
# Non-TTY here (a script's stdin), so a bare reset must refuse AND name the flag.
OUT=$("$SRV" reset 2>&1) && fail "headless reset exited 0"
echo "$OUT" | grep -q -- "--confirm" || fail "headless refusal did not name --confirm: $OUT"
ok "--yes refused by verb; headless names --confirm"

echo "== 2. init, boot, then a wrong-name reset changes nothing"
"$SRV" init --yes --no-service --port $PORT --host 127.0.0.1 --base-url "$BASE" >/dev/null 2>&1 || fail "init failed"
"$SRV" > "$W/server.log" 2>&1 &
SRVPID=$!
for i in $(seq 1 60); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/server.log"; fail "server never answered"; }
kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null; SRVPID=""
[ -f "$SUBSHELL_SERVER_CONFIG_DIR/config.env" ] || fail "config.env missing before the mismatch test"
OUT=$("$SRV" reset --confirm "definitely-not-$HOSTNAME_VAL" 2>&1) && fail "mismatched --confirm exited 0"
echo "$OUT" | grep -q "did not match" || fail "mismatch message missing: $OUT"
[ -f "$SUBSHELL_SERVER_CONFIG_DIR/config.env" ] || fail "a mismatched name DELETED config.env"
ok "wrong machine name: refused, bytes intact"

echo "== 3. reset deletes the data, keeps the binary"
"$SRV" reset --confirm "$HOSTNAME_VAL" > "$W/reset.log" 2>&1 || { cat "$W/reset.log"; fail "reset exit $?"; }
[ ! -f "$SUBSHELL_SERVER_CONFIG_DIR/config.env" ] || fail "config.env survived reset"
[ ! -e "$SUBSHELL_SERVER_DATA_DIR" ] || fail "data dir survived reset"
[ -x "$SRV" ] || fail "reset removed the binary it promised to keep"
ok "data and config gone, binary present"

echo "== 4. a hand-started daemon ends the chain before any byte goes"
# The scenario the manager seam cannot see: no service definition (--no-service
# init), so `reset` has nothing to stop, yet a live process owns the data. The
# port answering IS that fact; deleting under it would let the survivor
# repopulate WAL sidecars under a chain that just reported success.
"$SRV" init --yes --no-service --port $PORT --host 127.0.0.1 --base-url "$BASE" >/dev/null 2>&1 || fail "second init failed"
"$SRV" > "$W/daemon.log" 2>&1 &
SRVPID=$!
for i in $(seq 1 60); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/daemon.log"; fail "daemon never answered"; }
OUT=$("$SRV" reset --confirm "$HOSTNAME_VAL" 2>&1) && fail "reset deleted data under a live daemon"
echo "$OUT" | grep -q "still answering" || fail "live-daemon refusal missing: $OUT"
[ -f "$SUBSHELL_SERVER_CONFIG_DIR/config.env" ] || fail "the refused reset DELETED config.env"
kill "$SRVPID" 2>/dev/null; wait "$SRVPID" 2>/dev/null; SRVPID=""
ok "a live daemon on the port: refused, bytes intact"

echo "== 5. uninstall takes the data AND the binary it runs as"
"$SRV" uninstall --confirm "$HOSTNAME_VAL" > "$W/uninstall.log" 2>&1 || { cat "$W/uninstall.log"; fail "uninstall exit $?"; }
[ ! -f "$SUBSHELL_SERVER_CONFIG_DIR/config.env" ] || fail "config.env survived uninstall"
[ ! -e "$SRV" ] || fail "the binary survived uninstall"
ok "uninstall removed the data, the config, and its own running binary"

echo "✓ reset/uninstall scenario passed"
