#!/usr/bin/env bash
#
# `subshell update --from` end to end, COMPILED (spec 2026-09-15 §5.2).
#
# The node half of `server-update.sh`, and it exists for the same reason: no
# unit test can answer whether the swap works with two REAL binaries on disk.
# `bun run test` stubs `selfInvokePrefix`, the download and the probe; here
# nothing is stubbed — the installed binary resolves ITSELF, copies a file the
# operator named beside it, makes it executable, asks it what version it is,
# and renames twice.
#
# It is much cheaper than the server's: an agent has no database, no
# migrations and no boot-time transaction, so its whole rollback is putting
# `.previous` back. That means no server has to boot here at all — the only
# state `update` reads is the enrolled `config.json`, which this writes by
# hand rather than spending a setup key on a control plane it does not need.
#
# What is NOT covered here, and why: the 4406 REVERT, which is the other half
# of the node's transaction. It needs a control plane that refuses this agent's
# protocol, i.e. a server built from a different protocol constant — a second
# ~110 MB build to exercise a close handler that `daemon.test.ts` already
# drives directly. The unit test is the right size for it; this is the part
# only a real binary can answer.
#
# The `--from` half is deliberately SIGNATURE-FREE (spec 2026-09-17): a file
# the operator named beside the command IS their decision, already verified as
# far as it can be (it must say it is the agent at the version asked for).
# What step 10 adds is the other side of that line: a release fetched over the
# network whose manifest signature does not verify must abort with NOTHING
# replaced — proven here against a LOCAL fake release source, compiled, with
# no stub anywhere.
#
# Temp dirs and a throwaway config home — it touches no service manager, and
# step 10's throwaway port is the only network anything here opens.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT="$ROOT/apps/node/agent"
W=$(mktemp -d /tmp/ss-nupd-XXXX)
# The version bump below is a WORKING-TREE edit, restored on every exit path
# from a COPY of the file's bytes rather than with `git checkout` — several
# sessions share one checkout here, and `git checkout -- <path>` would also
# discard an uncommitted edit somebody else was holding in that file.
PKG="$AGENT/package.json"
PKG_BACKUP="$(mktemp /tmp/ss-nupd-pkg-XXXX)"
cp "$PKG" "$PKG_BACKUP"
cleanup() {
  [ -f "$PKG_BACKUP" ] && cp "$PKG_BACKUP" "$PKG" && rm -f "$PKG_BACKUP"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

export SUBSHELL_CONFIG_HOME="$W/config"
export SUBSHELL_RELEASE_URL=""   # `--from` only: this test reaches no network
mkdir -p "$SUBSHELL_CONFIG_HOME" "$W/data" "$W/bin"

CURRENT=$(bun -e "console.log(require('$AGENT/package.json').version)")
NEXT="99.0.0"

echo "== 1. install the CURRENT build as ~/bin/subshell ($CURRENT)"
cp "$AGENT/dist/subshell" "$W/bin/subshell"
chmod +x "$W/bin/subshell"
INSTALLED="$W/bin/subshell"
"$INSTALLED" version | grep -q "subshell $CURRENT" || fail "the installed binary does not report $CURRENT"
ok "installed $CURRENT"

echo "== 2. build a $NEXT binary from the same source"
# The version is inlined from package.json by the bundler, so a different
# version means a different package.json at build time. Edited and restored.
bun -e "
  const p = '$AGENT/package.json';
  const j = JSON.parse(require('fs').readFileSync(p, 'utf8'));
  j.version = '$NEXT';
  require('fs').writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
# The SAME flags `bun run compile` uses — see server-update.sh for why that is
# load-bearing rather than tidy.
(cd "$AGENT" && bun build --compile --bytecode --minify --sourcemap ./src/main.ts \
   --outfile "$W/next-subshell" >/dev/null) || fail "could not build the $NEXT binary"
cp "$PKG_BACKUP" "$PKG"
"$W/next-subshell" version | grep -q "subshell $NEXT" || fail "the new binary does not report $NEXT"
ok "built $NEXT"

echo "== 3. an enrolled config, written by hand"
# `update` reads exactly one thing out of it — `dataDir`, where the markers go
# — but `loadConfig` requires the whole enrolled shape, so this is what an
# enrolled node's file looks like. No plane is dialled: nothing here connects.
cat > "$SUBSHELL_CONFIG_HOME/config.json" <<JSON
{
  "serverUrl": "http://127.0.0.1:31996",
  "nodeId": "node-e2e-update",
  "nodeKey": "nk_not-a-real-key",
  "controlPublicKey": "not-a-real-key",
  "dataDir": "$W/data",
  "name": "cli-e2e"
}
JSON
chmod 600 "$SUBSHELL_CONFIG_HOME/config.json"
ok "config at $SUBSHELL_CONFIG_HOME/config.json"

echo "== 4. --check reports what is on offer without touching anything"
"$INSTALLED" update --check --from "$W/next-subshell" --json > "$W/check.json" || fail "update --check exited non-zero"
grep -q "\"latest\": \"$NEXT\"" "$W/check.json" || { cat "$W/check.json"; fail "--check did not name $NEXT"; }
grep -q '"updateAvailable": true' "$W/check.json" || { cat "$W/check.json"; fail "--check says nothing is available"; }
"$INSTALLED" version | grep -q "subshell $CURRENT" || fail "--check replaced the binary"
[ -f "$INSTALLED.previous" ] && fail "--check left a .previous behind"
ok "--check looked and did nothing"

echo "== 5. update --from, --no-restart (the swap, not the restart)"
"$INSTALLED" update --from "$W/next-subshell" --yes --no-restart --json > "$W/update.json" || {
  cat "$W/update.json"; fail "update exited non-zero";
}
grep -q "\"to\": \"$NEXT\"" "$W/update.json" || { cat "$W/update.json"; fail "the swap was not reported"; }
grep -q "\"from\": \"$CURRENT\"" "$W/update.json" || { cat "$W/update.json"; fail "the wrong from version"; }
grep -q '"restarted": false' "$W/update.json" || { cat "$W/update.json"; fail "--no-restart restarted anyway"; }
# The RESOLVED binary, not a convention: what it replaced is the file we ran.
"$INSTALLED" version | grep -q "subshell $NEXT" || fail "the installed path still runs the old binary"
[ -f "$INSTALLED.previous" ] || fail ".previous was not kept"
"$INSTALLED.previous" version | grep -q "subshell $CURRENT" || fail ".previous is not the old binary"
[ -f "$W/data/update-pending.json" ] || fail "no pending marker was written"
grep -q "\"to\": \"$NEXT\"" "$W/data/update-pending.json" || fail "the marker names the wrong version"
# Nothing was left in the directory it downloaded into.
ls "$W/bin/"subshell.download-* >/dev/null 2>&1 && fail "a download temp file was left behind"
ok "swapped to $NEXT, marker open, .previous kept"

echo "== 6. a second update refuses the file it is already running"
"$INSTALLED" update --from "$W/next-subshell" --yes --no-restart --json > "$W/again.json" || {
  cat "$W/again.json"; fail "update exited non-zero on an already-installed version";
}
grep -q '"changed": false' "$W/again.json" || { cat "$W/again.json"; fail "it swapped an identical version"; }
ok "already at $NEXT"

echo "== 7. --rollback puts the previous binary back"
"$INSTALLED" update --rollback --yes --json > "$W/rollback.json" || {
  cat "$W/rollback.json"; fail "rollback exited non-zero";
}
grep -q "\"to\": \"$CURRENT\"" "$W/rollback.json" || { cat "$W/rollback.json"; fail "rollback named the wrong version"; }
"$INSTALLED" version | grep -q "subshell $CURRENT" || fail "the rollback did not put $CURRENT back"
[ -f "$INSTALLED.previous" ] && fail ".previous survived the rollback"
[ -f "$W/data/update-pending.json" ] && fail "the pending marker survived the rollback"
ok "rolled back to $CURRENT"

echo "== 8. --rollback with nothing to roll back to fails loudly"
"$INSTALLED" update --rollback --yes >"$W/norollback.out" 2>&1 && fail "rollback succeeded with no .previous"
grep -qi "previous" "$W/norollback.out" || { cat "$W/norollback.out"; fail "the refusal does not name what is missing"; }
ok "refused with nothing to roll back to"

echo "== 9. a file that is not an agent is refused before anything is replaced"
printf '#!/bin/sh\necho hello\n' > "$W/not-an-agent"
chmod +x "$W/not-an-agent"
"$INSTALLED" update --from "$W/not-an-agent" --yes --no-restart >"$W/bogus.out" 2>&1 && \
  fail "a non-agent file was installed"
"$INSTALLED" version | grep -q "subshell $CURRENT" || fail "the binary was replaced by a non-agent file"
[ -f "$INSTALLED.previous" ] && fail "a refused update left a .previous"
[ -f "$W/data/update-pending.json" ] && fail "a refused update left a marker"
ok "refused a file that cannot say what it is"

echo "== 10. a network release whose manifest signature does not verify installs NOTHING"
# A local fake release source with the REAL structure and a BOGUS signature:
# the manifest, the digest and the bytes all line up, so the only fact that
# refuses is the publisher's armor. This is the compiled, end-to-end proof of
# the spec's whole claim — a release source can no longer get code onto this
# machine by itself — and it is what no unit test can answer, because the
# verifier runs against the pubkey COMPILED INTO this binary.
FAKE_RELEASE_PORT=31994
cat > "$W/fake-release.ts" <<EOF
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostReleaseTarget, releaseAssetNames } from "$ROOT/packages/subshell-protocol/src/releases.js";
const binary = releaseAssetNames("node", hostReleaseTarget(process.platform, process.arch)!).binary;
const bytes = readFileSync(process.argv[2]!);
const digest = createHash("sha256").update(bytes).digest("hex");
const port = Number(process.argv[3]!);
const base = \`http://127.0.0.1:\${port}\`;
const manifest = JSON.stringify({
  component: "node",
  version: process.argv[4]!,
  nodeProtocol: 12,
  minAgentVersion: "0.11.0",
  commit: "0".repeat(40),
  assets: { [binary]: digest },
});
Bun.serve({
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/releases") {
      return Response.json([
        {
          tag_name: \`node-v\${process.argv[4]}\`,
          draft: false,
          assets: [
            { name: "release-manifest.json", browser_download_url: \`\${base}/manifest\` },
            { name: "release-manifest.json.sig", browser_download_url: \`\${base}/sig\` },
            { name: binary, browser_download_url: \`\${base}/bin\` },
          ],
        },
      ]);
    }
    if (path === "/manifest") return new Response(manifest);
    if (path === "/sig") return new Response("not a minisign armor at all");
    if (path === "/bin") return new Response(bytes);
    return new Response("no", { status: 404 });
  },
});
console.log("fake release source listening");
EOF
bun "$W/fake-release.ts" "$W/next-subshell" "$FAKE_RELEASE_PORT" "$NEXT" > "$W/fake-release.log" 2>&1 &
FAKE_PID=$!
trap 'kill "$FAKE_PID" 2>/dev/null; cleanup' EXIT
for _ in $(seq 1 60); do grep -q "listening" "$W/fake-release.log" && break; sleep 0.25; done
grep -q "listening" "$W/fake-release.log" || { cat "$W/fake-release.log"; fail "fake release source never started"; }
SUBSHELL_RELEASE_URL="http://127.0.0.1:$FAKE_RELEASE_PORT/releases" \
  "$INSTALLED" update --to "$NEXT" --yes --no-restart >"$W/unsigned.out" 2>&1 && \
  fail "a release with a bogus manifest signature was installed"
grep -qi "not installable" "$W/unsigned.out" || { cat "$W/unsigned.out"; fail "the refusal did not name the release as un-installable"; }
"$INSTALLED" version | grep -q "subshell $CURRENT" || fail "the binary was replaced despite the failed signature"
[ -f "$INSTALLED.previous" ] && fail "the refused signed-release update left a .previous"
[ -f "$W/data/update-pending.json" ] && fail "the refused signed-release update left a marker"
ls "$W/bin/"subshell.download-* >/dev/null 2>&1 && fail "the refusal left a download temp behind"
kill "$FAKE_PID" 2>/dev/null
ok "refused the unsigned release; nothing downloaded, nothing replaced"

echo
echo "ALL NODE UPDATE CHECKS PASSED"
echo "workdir: $W"
