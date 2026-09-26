#!/usr/bin/env bash
# Issue #232: `subshell reset` and `subshell uninstall` COMPILED — the node
# role's doors. The refusal shapes (--yes cannot buy consent, headless names
# --confirm, a wrong name changes nothing), the data question's scripted
# answer (--reset-data, and its absence KEEPING the bytes), and the real
# deletes, against a sandbox config home and a COPIED binary. The copy
# matters exactly as it does for the server scenario: `uninstall` deletes the
# binary the ladder names, and run-under-copy lets it delete itself without
# harming the shared dist binary later scenarios read.
#
# Never touches the operator's machine: HOME, SUBSHELL_CONFIG_HOME and
# TMUX_TMPDIR are temp dirs (the service lookup therefore finds nothing under
# the fake HOME; the pane sweep sees an empty dir), no service is installed,
# and no plane is contacted: the chain is local by design.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_SRC="$ROOT/apps/node/agent/dist/subshell"
W=$(mktemp -d /tmp/ss-node-reset-e2e-XXXX)
export HOME="$W/home"
export SUBSHELL_CONFIG_HOME="$W/config"
export TMUX_TMPDIR="$W/tmux"
mkdir -p "$HOME" "$SUBSHELL_CONFIG_HOME" "$SUBSHELL_CONFIG_HOME/data"
printf x > "$HOME/.keepme"
SRV="$W/subshell"
cleanup() { rm -rf "$W"; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }
HOSTNAME_VAL="$(hostname)"
cp "$AGENT_SRC" "$SRV"

seed_state() {
  mkdir -p "$SUBSHELL_CONFIG_HOME/data/subshells" "$SUBSHELL_CONFIG_HOME/logs"
  printf '%s' '{"nodeId":"e2e-node-1","name":"e2e box"}' > "$SUBSHELL_CONFIG_HOME/config.json"
  printf '%s' '{}' > "$SUBSHELL_CONFIG_HOME/data/identity.json"
  printf '%s' 'pane bytes' > "$SUBSHELL_CONFIG_HOME/data/subshells/abc.log"
  printf '%s' 'agent bytes' > "$SUBSHELL_CONFIG_HOME/logs/agent.log"
  printf '%s' '{"pid":4194305,"startedAt":"2026-01-01T00:00:00Z","nodeId":"e2e-node-1","lastTickAt":"2026-01-01T00:00:00Z"}' > "$SUBSHELL_CONFIG_HOME/daemon.lock"
}

echo "== 1. refusal shapes cost nothing"
OUT=$("$SRV" reset --yes 2>&1 </dev/null) && fail "reset --yes exited 0"
echo "$OUT" | grep -q -- "--yes cannot confirm a reset" || fail "reset --yes refused without naming itself: $OUT"
OUT=$("$SRV" uninstall --yes 2>&1 </dev/null) && fail "uninstall --yes exited 0"
echo "$OUT" | grep -q -- "--yes cannot confirm an uninstall" || fail "uninstall --yes refused wrongly: $OUT"
OUT=$("$SRV" reset 2>&1 </dev/null) && fail "headless reset exited 0"
echo "$OUT" | grep -q -- "--confirm" || fail "headless refusal did not name --confirm: $OUT"
ok "--yes refused by verb; headless names --confirm"

echo "== 2. a wrong machine name changes nothing"
seed_state
OUT=$("$SRV" reset --confirm "definitely-not-$HOSTNAME_VAL" 2>&1 </dev/null) && fail "mismatched --confirm exited 0"
echo "$OUT" | grep -q "did not match" || fail "mismatch message missing: $OUT"
[ -f "$SUBSHELL_CONFIG_HOME/config.json" ] || fail "a mismatched name DELETED config.json"
ok "wrong machine name: refused, bytes intact"

echo "== 2b. a symlinked data home is guarded by its TARGET (fresh-eyes #239)"
# The reproduced back door: config.json's dataDir is a symlink to this
# scenario's HOME. The walk deletes through the realpath, so the guard must
# read the TARGET's shape. A run that deleted through this link would take
# the fake home; its marker is the proof nothing was touched.
ln -s "$HOME" "$W/data-link"
printf '%s' "{\"nodeId\":\"e2e-node-1\",\"name\":\"e2e box\",\"dataDir\":\"$W/data-link\"}" > "$SUBSHELL_CONFIG_HOME/config.json"
OUT=$("$SRV" reset --confirm "$HOSTNAME_VAL" 2>&1 </dev/null) && fail "symlinked dataDir to HOME exited 0"
echo "$OUT" | grep -q "unsafe path" || fail "symlink-to-home was not refused by its target: $OUT"
[ -f "$HOME/.keepme" ] || fail "the link's target home was touched"
ok "symlinked data home: refused by the target's shape, nothing deleted"

echo "== 3. reset deletes the node's state and KEEPS the binary"
seed_state
"$SRV" reset --confirm "$HOSTNAME_VAL" > "$W/reset.log" 2>&1 </dev/null; rc=$?
if [ "$rc" -ne 0 ]; then
  cat "$W/reset.log"
  fail "reset exit $rc"
fi
[ ! -f "$SUBSHELL_CONFIG_HOME/config.json" ] || fail "config.json survived reset"
[ ! -d "$SUBSHELL_CONFIG_HOME/data" ] || fail "the data dir survived reset"
[ -x "$SRV" ] || fail "reset removed the binary it promised to keep"
[ -f "$SUBSHELL_CONFIG_HOME/logs/agent.log" ] || fail "reset took the agent log it promised to leave"
grep -q -- "left the agent" "$W/reset.log" || fail "the run did not name the log it keeps: $(cat "$W/reset.log")"
ok "config, lock and data gone; binary and agent log stay"

echo "== 4. uninstall without --reset-data: the binary goes, the bytes stay"
seed_state
"$SRV" uninstall --confirm "$HOSTNAME_VAL" > "$W/keep.log" 2>&1 </dev/null; rc=$?
if [ "$rc" -ne 0 ]; then
  cat "$W/keep.log"
  fail "uninstall exit $rc"
fi
[ -f "$SUBSHELL_CONFIG_HOME/config.json" ] || fail "the default uninstall WIPED data it should keep"
grep -q -- "--reset-data" "$W/keep.log" || fail "the keep-log did not name the flag: $(cat "$W/keep.log")"
[ ! -e "$SRV" ] || fail "the binary survived uninstall"
ok "binary gone, config kept, flag named in the log"

echo "== 5. uninstall --reset-data takes the data too, and its own binary"
cp "$AGENT_SRC" "$SRV"
"$SRV" uninstall --confirm "$HOSTNAME_VAL" --reset-data > "$W/full.log" 2>&1 </dev/null; rc=$?
if [ "$rc" -ne 0 ]; then
  cat "$W/full.log"
  fail "uninstall --reset-data exit $rc"
fi
[ ! -f "$SUBSHELL_CONFIG_HOME/config.json" ] || fail "config.json survived --reset-data"
[ ! -d "$SUBSHELL_CONFIG_HOME/data" ] || fail "the data dir survived --reset-data"
[ ! -e "$SRV" ] || fail "the binary survived uninstall"
ok "uninstall --reset-data removed the state and its own running binary"

echo "✓ node reset/uninstall scenario passed"
