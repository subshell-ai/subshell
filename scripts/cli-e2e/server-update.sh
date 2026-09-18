#!/usr/bin/env bash
#
# `subshell-server update` end to end, COMPILED (spec 2026-09-15 §4.4, plan A8).
#
# The one thing no unit test can answer: whether the swap and the boot-time
# completion work with two real binaries on disk. `bun run test` stubs the
# binary-resolution ladder, the backup and the restore; here nothing is stubbed
# — a 0.6.0 binary is installed, a 9.9.9 binary is built from the same source
# with a patched version, `update --from` installs it, and the NEW binary's own
# boot is what has to finish the transaction.
#
# Deliberately `--from`-only, and `SUBSHELL_RELEASE_URL=""` enforces that: the
# file the operator named is verified as far as a local path can be (it must
# say it is `subshell-server` at the expected version), and the signed-manifest
# gate of spec 2026-09-17 applies to NETWORK sources, whose refusal IS signature
# verification — `--from` and `--rollback` are its two named exceptions. The
# network path's refusal is exercised COMPILED by `node-update.sh` step 10
# against a fake release source with a bogus armor (and step 11 proves the
# acceptance side compiled too, against a throwaway pubkey compiled into the
# exercising binary); the server's own network selection is covered at unit
# level (`releases.test.ts` — unsigned, forged, digest-mismatched manifests
# all refuse by name).
#
# What is NOT covered here, and why: the migration-failure REVERT. Making a
# compiled binary fail a migration on demand would mean a test seam inside
# `db/migrate.ts` — production code that exists only to break — and the plan
# allows the alternative. The revert is covered as a unit test on
# `services/update-transaction.ts` (`revertUpdate` restores the backup, puts
# `.previous` back and writes `failed.json`). What IS covered here compiled is
# the other half of the same hook: a marker whose binary never booted, which
# the older binary records as a failure and clears.
#
# Temp dirs, a throwaway config home and port 31997 — never :3080.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API="$ROOT/apps/server/api"
PORT=31997
BASE="http://127.0.0.1:$PORT"
W=$(mktemp -d /tmp/ss-upd-XXXX)
SRVPID=""
# The version bump below is a WORKING-TREE edit, so it is restored on every
# exit path — from a COPY of the file's bytes rather than with `git checkout`.
# The difference matters in this repo: several sessions share one checkout, and
# `git checkout -- <path>` would also discard an uncommitted edit somebody else
# was holding in that file. A byte-for-byte restore puts back exactly what was
# there, committed or not.
PKG="$API/package.json"
PKG_BACKUP="$(mktemp /tmp/ss-upd-pkg-XXXX)"
cp "$PKG" "$PKG_BACKUP"
cleanup() {
  [ -n "$SRVPID" ] && kill "$SRVPID" 2>/dev/null
  for p in $(lsof -nP -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  [ -f "$PKG_BACKUP" ] && cp "$PKG_BACKUP" "$PKG" && rm -f "$PKG_BACKUP"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

# ── host guard (measured 2026-09-18, the hard way) ──────────────────────────
# Which file `update` replaces is the one the SERVICE DEFINITION names, and
# the definition lives in the logged-in user's real launchd/systemd domain —
# no env override in this script reaches it. On a host whose operator HAS
# `subshell-server service install`ed, this scenario swaps the operator's
# real server for the 99.0.0 test build and reports success. The env vars
# below isolate config, data and ports; they cannot isolate that one question,
# so a host that answers it refuses to run. (CI runners install nothing,
# which is why this never fired before a dev box with a real install hit it.)
if [ "$(uname)" = "Darwin" ]; then
  if launchctl print "gui/$(id -u)/dev.subshell.server" >/dev/null 2>&1; then
    rm -rf "$W"; trap - EXIT
    fail "this host has a per-user Subshell Server launchd job; the service definition (not this sandbox) decides which binary 'update' replaces, so the scenario refuses to run here. Use CI or a machine with no install."
  fi
elif command -v systemctl >/dev/null 2>&1 \
  && systemctl --user cat subshell-server.service >/dev/null 2>&1; then
  rm -rf "$W"; trap - EXIT
  fail "this host has a per-user systemd subshell-server unit; the service definition (not this sandbox) decides which binary 'update' replaces, so the scenario refuses to run here. Use CI or a machine with no install."
fi
ok "no real per-user service definition on this host"

export SUBSHELL_SERVER_CONFIG_DIR="$W/srv-config"
export SUBSHELL_SERVER_DATA_DIR="$W/srv-data"
export SUBSHELL_RELEASE_URL=""   # `--from` only: this test reaches no network
# A throwaway HOME, exactly as `install-script.sh` does and as this script's
# own header promises. It is NOT cosmetic: the binary-resolution ladder
# consults `homedir()` for the MANAGED copy (`~/.local/bin/subshell-server`,
# `services/installed-binary.ts`), and on a machine that has one — every
# machine that ever ran the desktop app — an un-exported HOME makes `update`
# swap THE OPERATOR'S OWN BINARY and report success. Measured 2026-09-17:
# step 5 died with the old version still at `$INSTALLED` while
# `~/.local/bin/subshell-server` had become this test's 99.0.0 build, and
# step 4's SUFFIX match could not tell the two paths apart.
export HOME="$W/home"
mkdir -p "$SUBSHELL_SERVER_CONFIG_DIR" "$SUBSHELL_SERVER_DATA_DIR" "$W/bin" "$HOME"

CURRENT=$(node -p "require('$API/package.json').version" 2>/dev/null || \
          bun -e "console.log(require('$API/package.json').version)")
NEXT="99.0.0"

echo "== 1. install the CURRENT build as ~/bin/subshell-server ($CURRENT)"
cp "$API/dist/subshell-server" "$W/bin/subshell-server"
chmod +x "$W/bin/subshell-server"
INSTALLED="$W/bin/subshell-server"
"$INSTALLED" version | grep -q "subshell-server $CURRENT" || fail "the installed binary does not report $CURRENT"
ok "installed $CURRENT"

echo "== 2. build a $NEXT binary from the same source"
# The version is inlined from package.json by the bundler, so a different
# version means a different package.json at build time. Edited and restored.
bun -e "
  const p = '$API/package.json';
  const j = JSON.parse(require('fs').readFileSync(p, 'utf8'));
  j.version = '$NEXT';
  require('fs').writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
# The SAME flags `bun run compile` uses, and that is load-bearing rather than
# tidy: measured 2026-09-15, a `bun build --compile` WITHOUT `--bytecode
# --minify` boots as far as the plugin-store line and then hangs silently. This
# test is about the update, so it builds what the repo builds.
(cd "$API" && bun build --compile --target=bun --bytecode --minify --sourcemap ./src/index.ts \
   --outfile "$W/next-subshell-server" >/dev/null) || fail "could not build the $NEXT binary"
cp "$PKG_BACKUP" "$PKG"
"$W/next-subshell-server" version | grep -q "subshell-server $NEXT" || fail "the new binary does not report $NEXT"
ok "built $NEXT"

echo "== 3. init and boot the installed $CURRENT"
"$INSTALLED" init --yes --no-service --port $PORT --host 127.0.0.1 --base-url "$BASE" >/dev/null 2>&1 \
  || fail "init failed"
"$INSTALLED" > "$W/server-old.log" 2>&1 &
SRVPID=$!
for _ in $(seq 1 60); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/server-old.log"; fail "the server never answered"; }
ok "server $CURRENT answering on $PORT"

echo "== 4. status knows which binary it would replace"
"$INSTALLED" status --json > "$W/status-before.json" || fail "status exited non-zero"
# CONTAINMENT, not suffix: `process.execPath` is realpath'd (macOS `/tmp/…`
# comes back `/private/tmp/…`), so both sides are realpath'd and the
# comparison is "INSIDE this work dir". The check used to be a suffix match
# on `/bin/subshell-server` — which the OPERATOR'S real install also satisfies
# on a dev host, which is how a run here once swapped the real binary and
# still printed "status names the installed binary". The host guard above
# refuses that configuration up front; this line is the belt, because it
# asks the same question `update` will answer.
REPORTED=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$W/status-before.json','utf8')).paths?.binary ?? '')")
[ -n "$REPORTED" ] || { cat "$W/status-before.json"; fail "status did not name the installed binary"; }
case "$(realpath "$REPORTED" 2>/dev/null || echo "$REPORTED")" in
  "$(realpath "$W")"/*) ;;
  *) fail "status names a binary OUTSIDE the sandbox ($REPORTED) — the swap would replace it" ;;
esac
grep -q '"kind": "compiled"' "$W/status-before.json" || fail "status did not call it compiled"
ok "status names the sandboxed installed binary"

echo "== 5. update --from, --no-restart (the swap, not the restart)"
OUT=$("$INSTALLED" update --from "$W/next-subshell-server" --yes --no-restart 2>&1) || {
  echo "$OUT"; fail "update exited non-zero";
}
echo "$OUT" | grep -q "Backed up the database to" || { echo "$OUT"; fail "no backup was taken"; }
echo "$OUT" | grep -q "Installed $NEXT" || { echo "$OUT"; fail "the swap was not reported"; }
"$INSTALLED" version | grep -q "subshell-server $NEXT" || fail "the installed path still runs the old binary"
[ -f "$INSTALLED.previous" ] || fail ".previous was not kept"
[ -f "$SUBSHELL_SERVER_DATA_DIR/update/pending.json" ] || fail "no pending marker was written"
grep -q "\"to\": \"$NEXT\"" "$SUBSHELL_SERVER_DATA_DIR/update/pending.json" || fail "the marker names the wrong version"
ls "$SUBSHELL_SERVER_DATA_DIR/backups/"*.db >/dev/null 2>&1 || fail "no backup file on disk"
ok "swapped to $NEXT, marker open, backup on disk"

echo "== 6. the NEW binary's boot completes the transaction"
kill $SRVPID 2>/dev/null; wait $SRVPID 2>/dev/null; SRVPID=""
for _ in $(seq 1 20); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 || break; sleep 0.5; done
"$INSTALLED" > "$W/server-new.log" 2>&1 &
SRVPID=$!
for _ in $(seq 1 60); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/server-new.log"; fail "the new binary never answered"; }
grep -q "subshell-server $NEXT" "$W/server-new.log" || fail "the boot log does not name $NEXT"
for _ in $(seq 1 20); do [ -f "$SUBSHELL_SERVER_DATA_DIR/update/pending.json" ] || break; sleep 0.5; done
[ -f "$SUBSHELL_SERVER_DATA_DIR/update/pending.json" ] && fail "the marker was not cleared"
[ -f "$INSTALLED.previous" ] && fail ".previous was not removed"
[ -f "$SUBSHELL_SERVER_DATA_DIR/update/failed.json" ] && fail "the boot recorded a failure"
grep -q "update complete: $CURRENT → $NEXT" "$W/server-new.log" || fail "no completion line in the boot log"
ok "the boot completed the transaction"

echo "== 7. the audit row is there, with actor null"
# Read it straight from SQLite: the route needs an admin cookie, and this
# instance deliberately has no account.
DB=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$W/status-before.json','utf8')).paths.database)")
bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB', { readonly: true });
  const row = db.query(\"select actor_user_id as a, metadata_json as m from audit_events where action = 'server.update' order by created_at desc limit 1\").get();
  if (!row) { console.error('no server.update audit row'); process.exit(1); }
  if (row.a !== null) { console.error('actor should be null, got ' + row.a); process.exit(1); }
  const meta = JSON.parse(row.m);
  if (meta.from !== '$CURRENT' || meta.to !== '$NEXT' || meta.origin !== 'cli') {
    console.error('unexpected metadata: ' + row.m); process.exit(1);
  }
" || fail "the audit row is wrong"
ok "audited server.update ($CURRENT → $NEXT, actor null)"

echo "== 8. a marker whose binary never booted is RECORDED, not left pending"
kill $SRVPID 2>/dev/null; wait $SRVPID 2>/dev/null; SRVPID=""
for _ in $(seq 1 20); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 || break; sleep 0.5; done
# Forge the state an interrupted update leaves: a marker claiming a version
# this binary is not. The boot hook must record the failure and clear it —
# otherwise the marker refuses every later update forever.
mkdir -p "$SUBSHELL_SERVER_DATA_DIR/update"
cat > "$SUBSHELL_SERVER_DATA_DIR/update/pending.json" <<JSON
{
  "from": "$NEXT",
  "to": "123.0.0",
  "binary": "$INSTALLED",
  "previousBinary": "$INSTALLED.previous",
  "backup": null,
  "startedAt": "2026-09-15T00:00:00.000Z",
  "origin": "cli",
  "forced": false
}
JSON
"$INSTALLED" > "$W/server-stale.log" 2>&1 &
SRVPID=$!
for _ in $(seq 1 60); do curl -sf "$BASE/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$BASE/api/setup/status" >/dev/null || { cat "$W/server-stale.log"; fail "the server did not come back"; }
[ -f "$SUBSHELL_SERVER_DATA_DIR/update/pending.json" ] && fail "the stale marker was left pending"
grep -q "\"error\"" "$SUBSHELL_SERVER_DATA_DIR/update/failed.json" || fail "no failure was recorded"
grep -q "expected 123.0.0 to boot" "$SUBSHELL_SERVER_DATA_DIR/update/failed.json" || fail "the failure names the wrong thing"
ok "recorded the failure and cleared the marker"

echo "== 9. backup takes a snapshot on demand"
"$INSTALLED" backup --json > "$W/backup.json" || fail "backup exited non-zero"
grep -q '"bytes"' "$W/backup.json" || { cat "$W/backup.json"; fail "backup printed no size"; }
BACKUP=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$W/backup.json','utf8')).path)")
[ -f "$BACKUP" ] || fail "the backup file is not there"
[ "$(stat -f '%Lp' "$BACKUP" 2>/dev/null || stat -c '%a' "$BACKUP")" = "600" ] || fail "the backup is not 0600"
ok "backup wrote $BACKUP (0600)"

kill $SRVPID 2>/dev/null; wait $SRVPID 2>/dev/null
echo
echo "ALL SERVER UPDATE CHECKS PASSED"
echo "workdir: $W"
