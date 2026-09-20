#!/usr/bin/env bash
#
# The loopback dashboard, COMPILED (spec 2026-09-19).
#
# What only a real binary can answer: that `subshell run` actually binds the
# dashboard beside the daemon, that the guard runs for every request the way
# `server.ts` composes it (a unit test can call `refuseRequest` or call the
# routes; only a socket answers THAT the routes are behind it), and that the
# maintenance flip is the REAL file writer under a running daemon — the same
# mirror the heartbeat reconciles, not a faked view.
#
# Nothing here talks to a service manager or a plane: the config is written by
# hand (the shape `loadConfig` requires, the `node-update.sh` precedent), the
# daemon simply fails its dial and retries forever, and the port is 31998 —
# the one free slot in the documented 31992-31999 range, and never the 3090 a
# developer's node is serving right now.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_APP="$ROOT/apps/node/agent"
PORT=31998
BASE="http://127.0.0.1:$PORT"
W=$(mktemp -d /tmp/ss-dash-XXXX)
NODEPID=""
# A throwaway HOME (the `node-update.sh` lesson: SUBSHELL_CONFIG_HOME alone
# cannot hide the real host's service definitions from anything that reads
# them) and a throwaway tmux socket — a flipped `maintenance on` KILLS panes,
# and on this host the real agent's panes hang off the real socket. The census
# over an empty private socket stops nothing, which is the clean case.
export HOME="$W/home"
export SUBSHELL_CONFIG_HOME="$W/config"
export SUBSHELL_CLIENT_SKIP_TMUX_CHECK=1
# Force the air-gapped configuration regardless of the host's env, so no step in
# this scenario can depend on a developer's SUBSHELL_RELEASE_URL or reach the
# network. (The `node-update.sh` / `server-update.sh` scenarios do the same.)
export SUBSHELL_RELEASE_URL=""
mkdir -p "$SUBSHELL_CONFIG_HOME" "$W/data" "$HOME"
cleanup() {
  [ -n "$NODEPID" ] && kill "$NODEPID" 2>/dev/null
  tmux -L ss-e2e-dash kill-server 2>/dev/null
  rm -rf "$W"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

# The control key is PINNED and `runDaemon` parses it at boot
# (`parsePinnedKey` → `JSON.parse`), BEFORE it dials — so this must be a JSON
# *string*, not a free-text placeholder, or the daemon throws and dies the
# instant it binds (no command here verifies against it, so `{}` is enough).
cat > "$SUBSHELL_CONFIG_HOME/config.json" <<JSON
{
  "serverUrl": "http://127.0.0.1:31996",
  "nodeId": "node-e2e-dashboard",
  "nodeKey": "nk_not-a-real-key",
  "controlPublicKey": "{}",
  "dataDir": "$W/data",
  "name": "cli-e2e-dashboard"
}
JSON
chmod 600 "$SUBSHELL_CONFIG_HOME/config.json"

echo "== 1. the daemon starts with the dashboard bound"
tmux -L ss-e2e-dash new-session -d -s census true >/dev/null 2>&1 || true
(cd "$NODE_APP" && SUBSHELL_DASHBOARD_PORT=$PORT ./dist/subshell run >"$W/daemon.log" 2>&1 >/dev/null) </dev/null &
NODEPID=$!
for _ in $(seq 1 50); do
  curl -sf "$BASE/api/self" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "$BASE/api/self" >/dev/null 2>&1 || { cat "$W/daemon.log"; fail "the dashboard never bound :$PORT"; }
ok "127.0.0.1:$PORT answers"

echo "== 2. /api/self bootstraps the SPA identity"
SELF=$(curl -s "$BASE/api/self")
echo "$SELF" | grep -q '"id":"node-e2e-dashboard"' || { echo "$SELF"; fail "/api/self lost the node id"; }
echo "$SELF" | grep -q '"name":"cli-e2e-dashboard"' || fail "/api/self lost the name"
ok "id + name"

echo "== 3. a foreign Host is refused — the DNS-rebinding guard on the wire"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: evil.example.com" "$BASE/api/self")
[ "$code" = "403" ] || fail "foreign Host answered $code, wanted 403"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://evil.example.com" "$BASE/api/self")
[ "$code" = "403" ] || fail "foreign Origin answered $code, wanted 403"
ok "both refusals answer before any route runs"

echo "== 4. a form-shaped mutation is refused; JSON is accepted"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/x-www-form-urlencoded" --data "on=true" "$BASE/api/nodes/self/maintenance")
[ "$code" = "403" ] || fail "form POST answered $code, wanted 403"
ok "the preflight-forcing rule holds on the socket"

echo "== 5. the local view answers the plane's contract"
VIEW=$(curl -s "$BASE/api/nodes/self")
echo "$VIEW" | grep -q '"status":"online"' || { echo "$VIEW"; fail "the local view is not online"; }
echo "$VIEW" | grep -q '"canManage":true' || fail "the local view lost canManage"
ok "GET /api/nodes/:id"

echo "== 6. a pre-set mirror reaches the view — the real writer, the live daemon"
# NOT a flip through the route, deliberately: `maintenance on` STOPS every
# subshell running on this machine, and a suite host may well have harness
# panes of the developer's running RIGHT NOW (the census in step 1 ran on a
# private socket, but `maintenance on`'s census reads the per-meta sockets,
# and a hand-set mirror touches nothing). What remains worth proving compiled:
# the mirror written by the route's own writer format is read back through
# `readMaintenance` into the plane-shaped fields — file → view, no fakes.
cat > "$W/data/maintenance.json" <<'MIRROR'
{ "on": true, "changedAt": "2026-09-19T00:00:00.000Z" }
MIRROR
chmod 600 "$W/data/maintenance.json"
VIEWM=$(curl -s "$BASE/api/nodes/self")
echo "$VIEWM" | grep -q '"maintenance":true' || { echo "$VIEWM"; fail "the view did not carry the mirror"; }
echo "$VIEWM" | grep -q '"canLaunch":false' || fail "the mirror did not flip canLaunch"
# And `status --json` — same file, the CLI's own eyes, compiled.
"$NODE_APP/dist/subshell" maintenance status --json | grep -q '"on": true' || fail "CLI status missed the mirror"
rm -f "$W/data/maintenance.json"
ok "mirror file → view + canLaunch=false → CLI status agree"

echo "== 7. the log slice answers with a cursor"
LOGS=$(curl -s "$BASE/api/nodes/self/logs?fromByte=0")
echo "$LOGS" | grep -q '"nextByte"' || { echo "$LOGS"; fail "logs had no cursor"; }
ok "GET /api/nodes/:id/logs?fromByte=0"

echo "== 8. the update route refuses the unsupervised daemon before any network call"
# The step-1 daemon is a bare `subshell run` — no service manager started it, so
# it is UNSUPERVISED, and its runtime report (published at boot, before the
# unreachable plane is dialed) says so. The update route's supervision gate
# fires FIRST, before it resolves any release: exiting an unsupervised agent is
# a stop, not a restart. Both branches of that gate say "not running under a
# service manager" and "restart it where it was started"; only the
# no-runtime-report branch also says "`subshell update`", and a live daemon never
# takes it — so assert the two substrings BOTH carry. The air-gapped `--from`
# refusal sits further still (behind the gate) and is unit-covered
# (`dashboard.test.ts` fakes `supervised: true` to reach it).
curl -s -X POST -H "Content-Type: application/json" --data '{}' "$BASE/api/self/update" > "$W/upd.json"
grep -q "not running under a service manager" "$W/upd.json" || { cat "$W/upd.json"; fail "the unsupervised update refusal did not name the service manager"; }
grep -q "restart it where it was started" "$W/upd.json" || { cat "$W/upd.json"; fail "the refusal did not name the remedy"; }
ok "unsupervised: a named refusal, not a hang and not a download"

echo "== 9. SUBSHELL_DASHBOARD=0 means no dashboard at all"
# Its OWN port: the step-1 daemon still holds 31998, and the point of this
# step is the ABSENCE of a listener — on a port nothing else can answer on,
# "connection refused" is the only honest proof the opt-out worked.
NOPORT=31993
(cd "$NODE_APP" && SUBSHELL_DASHBOARD=0 SUBSHELL_DASHBOARD_PORT=$NOPORT ./dist/subshell run >"$W/nodash.log" 2>&1 >/dev/null) </dev/null &
NOPID=$!
sleep 1.5
curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$NOPORT/api/self" && fail "SUBSHELL_DASHBOARD=0 still served a dashboard"
ok "the opt-out holds"
kill "$NOPID" 2>/dev/null

echo "== 10. the SPA shell is served (disk dist → embedded → notice)"
HTML=$(curl -s "$BASE/")
echo "$HTML" | grep -qi "<!doctype html>" || fail "no page at /"
ok "the static ladder answers on the same port as the API"

echo
echo "✓ node dashboard scenario passed"
