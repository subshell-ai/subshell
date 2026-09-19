#!/usr/bin/env bash
# End-to-end headless test: server CLI init -> boot -> first admin -> setup key
# -> node CLI setup -> node online. Temp dirs only, port 31999, never :3080.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRV="$ROOT/apps/server/api/dist/subshell-server"
NODE="$ROOT/apps/node/agent/dist/subshell"
PORT=31999
BASE="http://127.0.0.1:$PORT"
W=$(mktemp -d /tmp/ss-e2e-XXXX)
export SUBSHELL_SERVER_CONFIG_DIR="$W/srv-config"
export SUBSHELL_SERVER_DATA_DIR="$W/srv-data"
mkdir -p "$SUBSHELL_SERVER_CONFIG_DIR" "$SUBSHELL_SERVER_DATA_DIR"
JAR="$W/cookies"
SRVPID=""; NODEPID=""
cleanup() {
  # A `fail` used to exit before the kill at the bottom, orphaning a server
  # that then held the port and made the NEXT run fail somewhere else
  # entirely. Kill from a trap so every exit path tears down.
  [ -n "$NODEPID" ] && kill "$NODEPID" 2>/dev/null
  [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null
  for p in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

echo "== 1. init (headless, non-interactive)"
OUT=$("$SRV" init --yes --no-service --port $PORT --host 127.0.0.1 --base-url "$BASE" 2>&1) || fail "init exit $?"
echo "$OUT" | grep -q "/setup in a browser to create the admin account" || fail "init printed no handoff line"
ok "init wrote config and printed the handoff"

echo "== 2. status before boot"
"$SRV" status 2>&1 | grep -q "setup *= database not created yet" || fail "status did not report a missing database"
ok "status says the database does not exist yet"

echo "== 3. boot"
"$SRV" > "$W/server.log" 2>&1 &
SRVPID=$!
for i in $(seq 1 60); do
  curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/server.log"; fail "server never answered"; }
ok "server answering on $PORT"
# The `/setup` handoff is logged AFTER the listening lines: `index.ts` runs
# `prepareNetworkProcesses` + `refreshNetworkOrigins` + the `hasAnyUser` count
# between `startServer` answering the readiness poll above and this line, a
# few hundred ms on a cold compiled boot. Grepping the log once at the instant
# the endpoint first answered read as "boot log did not name /setup" while the
# server was working perfectly — so poll for the line, same as every other
# eventual fact this script waits on.
NAMED=no
for i in $(seq 1 20); do
  grep -q "No account yet" "$W/server.log" && { NAMED=yes; break; }
  sleep 0.5
done
[ "$NAMED" = yes ] || { cat "$W/server.log"; fail "boot log did not name /setup"; }
ok "boot log told the operator where to create the account"

echo "== 4. status with a database but no users"
"$SRV" status 2>&1 | grep -q "no admin account yet" || fail "status did not report a missing admin"
ok "status says no admin account yet"

echo "== 5. first admin via the public first-run window"
curl -sf -c "$JAR" -X POST "$BASE/api/auth/sign-up/email" -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery","name":"Admin"}' -o "$W/signup.json" \
  || { cat "$W/signup.json" 2>/dev/null; fail "sign-up failed"; }
ok "admin account created"
curl -sf "$BASE/api/setup/status" | grep -q '"needsSetup":false' || fail "needsSetup still true"
ok "setup window closed"

echo "== 6. status after the account exists"
"$SRV" status 2>&1 | grep -q "setup *= admin account exists" || fail "status did not see the admin"
ok "status says the admin account exists"

echo "== 6b. sign in (a sign-up need not mint a session)"
curl -s -c "$JAR" -X POST "$BASE/api/auth/sign-in/email" -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"correct-horse-battery"}' -o "$W/signin.json" -w '%{http_code}\n' > "$W/signin.code"
ok "sign-in HTTP $(cat "$W/signin.code")"

echo "== 7. mint a node setup key (admin cookie)"
# No body: the mint takes nothing since the node started naming itself, and posting a
# `label` here would hide that — and pass, because a route ignores what it does not read.
curl -s -b "$JAR" -X POST "$BASE/api/nodes/setup-keys" -o "$W/key.json" -w '%{http_code}\n' > "$W/key.code"
KEY=$(sed -n 's/.*"key":"\([^"]*\)".*/\1/p' "$W/key.json")
[ -n "$KEY" ] || { echo "HTTP $(cat "$W/key.code")"; head -c 400 "$W/key.json"; echo; fail "no setup key minted"; }
ok "setup key minted"

echo "== 7b. the COMPILED enroll refuses a nameless invocation, and spends nothing"
# Unit level this is one argv check; compiled, it is the only proof that the refusal
# still happens before the identity, the network and the key. The next step is that
# proof: it redeems THIS key, so a refusal that had spent it fails there instead.
ENROLL_OUT=$("$NODE" enroll --server "$BASE" --key "$KEY" --data-dir "$W/node-data-nope" 2>&1)
ENROLL_RC=$?
[ "$ENROLL_RC" -eq 2 ] || { echo "exit $ENROLL_RC: $ENROLL_OUT"; fail "a nameless enroll must be a usage error (exit 2)"; }
echo "$ENROLL_OUT" | grep -q -- "--name" || { echo "$ENROLL_OUT"; fail "the refusal did not name the flag to pass"; }
[ -e "$W/node-data-nope/identity.json" ] && fail "a refused enroll minted an identity before it refused"
ok "nameless enroll: exit 2, named --name, minted no identity, left the key unspent"

echo "== 8. node CLI: subshell setup"
export SUBSHELL_CONFIG_HOME="$W/node-config"
mkdir -p "$SUBSHELL_CONFIG_HOME"
OUT=$("$NODE" setup --server "$BASE" --key "$KEY" --name e2e-node --data-dir "$W/node-data" --no-service 2>&1) || { echo "$OUT"; fail "setup exit $?"; }
echo "$OUT" | grep -q "/nodes" || fail "setup printed no next step naming the nodes page"
echo "$OUT" | grep -qi "subshell run" && fail "setup still recommends the foreground run"
ok "setup enrolled and named the nodes page"

echo "== 9. run the agent and confirm it comes online"
"$NODE" run > "$W/agent.log" 2>&1 &
NODEPID=$!
ONLINE=no
for i in $(seq 1 40); do
  if curl -sf -b "$JAR" "$BASE/api/nodes" | grep -q '"status":"online"'; then ONLINE=yes; break; fi
  sleep 0.5
done
[ "$ONLINE" = yes ] || { tail -20 "$W/agent.log"; fail "node never came online"; }
ok "node is online on the control plane"

echo "== 10. node status"
"$NODE" status 2>&1 | head -2

kill $NODEPID $SRVPID 2>/dev/null
wait $NODEPID $SRVPID 2>/dev/null
echo
echo "ALL CLI E2E CHECKS PASSED"
echo "workdir: $W"
