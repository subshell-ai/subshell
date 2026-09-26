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
# no stub anywhere. Step 11 closes the pair from the ACCEPTANCE side: a
# release signed by a throwaway keypair — compiled into the exercising binary
# the way the version is patched — must INSTALL, taking its digest from the
# signed manifest even when the sidecar beside it lies, and must refuse the
# same bytes once one hex character of the manifest is tampered after signing.
#
# Temp dirs and a throwaway config home — it touches no service manager, and
# steps 10 and 11's throwaway ports are the only network anything here opens.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_APP="$ROOT/apps/node/agent"
W=$(mktemp -d /tmp/ss-nupd-XXXX)
# The version bump below is a WORKING-TREE edit, restored on every exit path
# from a COPY of the file's bytes rather than with `git checkout` — several
# sessions share one checkout here, and `git checkout -- <path>` would also
# discard an uncommitted edit somebody else was holding in that file.
PKG="$NODE_APP/package.json"
PKG_BACKUP="$(mktemp /tmp/ss-nupd-pkg-XXXX)"
cp "$PKG" "$PKG_BACKUP"
# Step 11 patches the publisher pubkey the way step 2 patches the version —
# same rule: restore from a byte copy on every exit path, never `git
# checkout`, several sessions share this checkout. Empty until step 11 runs,
# and — load-bearing — it stays set until the RESTORED source has been
# rebuilt into the dist, because cleanup() gates that rebuild on it.
PUBKEY_TS="$ROOT/packages/subshell-protocol/src/releases.ts"
PUBKEY_BACKUP=""
FAKE_PID=""
ACC_PID=""
TAMP_PID=""
cleanup() {
  [ -f "$PKG_BACKUP" ] && cp "$PKG_BACKUP" "$PKG" && rm -f "$PKG_BACKUP"
  if [ -n "$PUBKEY_BACKUP" ] && [ -f "$PUBKEY_BACKUP" ]; then
    cp "$PUBKEY_BACKUP" "$PUBKEY_TS" && rm -f "$PUBKEY_BACKUP"
    # The rebuilt dist carries the patched constant until rebuilt again:
    # leaving the tree holding a throwaway publisher identity would feed it
    # to the NEXT compile of anything. Best-effort still — this is the exit
    # path — but SILENT is the failure being fixed: a dist nobody names is a
    # dist nobody rebuilds.
    (cd "$ROOT/packages/subshell-protocol" && bun run build >/dev/null 2>&1) \
      || echo "WARN: could not rebuild the protocol dist from the restored source; it may still carry the throwaway pubkey. Fix by hand: (cd packages/subshell-protocol && bun run build)" >&2
  fi
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

export SUBSHELL_CONFIG_HOME="$W/config"
export SUBSHELL_RELEASE_URL=""   # `--from` only: this test reaches no network
# A throwaway HOME, for the same reason `server-update.sh` swaps one and says
# so at length — and this scenario went without it until 2026-09-19, when the
# omission bit a developer's machine.
#
# `SUBSHELL_CONFIG_HOME` is NOT enough. `resolveNodeBinary`
# (`apps/node/agent/src/update.ts`) asks the SERVICE DEFINITION first, and it
# hangs the plist/unit paths off `homedir()`, not off the config home. So on a
# host carrying `~/Library/LaunchAgents/dev.subshell.client.plist` — every
# machine that ever enrolled through Subshell Client — the sandbox is bypassed
# by the one lookup that runs before it, and `update` replaces THE OPERATOR'S
# OWN `~/.local/bin/subshell` and reports success. Measured 2026-09-19 on a
# host whose plist appeared the previous day; ten earlier runs in
# `/tmp/ss-nupd-*` had resolved to the temp dir correctly purely because no
# plist existed yet, which is why this survived so long.
export HOME="$W/home"
mkdir -p "$SUBSHELL_CONFIG_HOME" "$W/data" "$W/bin" "$HOME"

CURRENT=$(bun -e "console.log(require('$NODE_APP/package.json').version)")
NEXT="99.0.0"

echo "== 1. install the CURRENT build as ~/bin/subshell ($CURRENT)"
cp "$NODE_APP/dist/subshell" "$W/bin/subshell"
chmod +x "$W/bin/subshell"
INSTALLED="$W/bin/subshell"
"$INSTALLED" version | grep -q "subshell $CURRENT" || fail "the installed binary does not report $CURRENT"
ok "installed $CURRENT"

echo "== 2. build a $NEXT binary from the same source"
# The version is inlined from package.json by the bundler, so a different
# version means a different package.json at build time. Edited and restored.
bun -e "
  const p = '$NODE_APP/package.json';
  const j = JSON.parse(require('fs').readFileSync(p, 'utf8'));
  j.version = '$NEXT';
  require('fs').writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
# The SAME flags `bun run compile` uses — see server-update.sh for why that is
# load-bearing rather than tidy.
(cd "$NODE_APP" && bun build --compile --bytecode --minify --sourcemap ./src/main.ts \
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
const binary = releaseAssetNames("cli-node", hostReleaseTarget(process.platform, process.arch)!).binary;
const bytes = readFileSync(process.argv[2]!);
const digest = createHash("sha256").update(bytes).digest("hex");
const port = Number(process.argv[3]!);
const base = \`http://127.0.0.1:\${port}\`;
const manifest = JSON.stringify({
  component: "cli-node",
  version: process.argv[4]!,
  nodeProtocol: 12,
  minNodeVersion: "0.11.0",
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
          tag_name: \`cli-node-v\${process.argv[4]}\`,
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
trap 'kill ${FAKE_PID:-} ${ACC_PID:-} ${TAMP_PID:-} 2>/dev/null; cleanup' EXIT
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

echo "== 11. a release signed by a THROWAWAY key installs COMPILED, on the manifest's digest"
# Step 10 proves the compiled agent REFUSES what the publisher did not sign.
# This is the acceptance half: the same fake-source shape, but the manifest
# is signed for real — by a throwaway keypair generated exactly the way the
# fixture README documents, and COMPILED INTO the exercising binary. There is
# no production seam for this and there must never be one (an env or flag
# pubkey override is the hole this whole feature exists to not have), so the
# scenario does to the `RELEASE_PUBKEY` constant what step 2 does to the
# version: patch the source from a byte copy, compile, restore, and rebuild
# the package's dist — inline, and again from the trap on any earlier exit.
#
# The served release lies in exactly one way: its `.sha256` sidecar names a
# DIFFERENT digest than the signed manifest's `assets` entry. That the install
# SUCCEEDS is therefore the proof the digest came from the signed map — a
# regression that trusted the sidecar would abort on a digest mismatch. Then
# the manifest itself gets one hex character of that digest flipped AFTER
# signing, and the same binary must refuse: the byte-level pair around §4's
# rule, run compiled.
ACC_PORT=31993
TAMP_PORT=31992
PUBKEY_BACKUP="$(mktemp /tmp/ss-nupd-pubkey-XXXX)"
cp "$PUBKEY_TS" "$PUBKEY_BACKUP"
bunx @tauri-apps/cli signer generate -w "$W/e2e.key" -p e2epass --ci >/dev/null \
  || fail "could not generate the throwaway keypair"
bun -e "
  const fs = require('node:fs');
  const q = String.fromCharCode(34);
  const src = fs.readFileSync(process.argv[1], 'utf8');
  const re = /export const RELEASE_PUBKEY =\s*\x22[^\x22]*\x22;/;
  if (!re.test(src)) { console.error('RELEASE_PUBKEY literal not found — the patcher walked off the source'); process.exit(1); }
  const pub = fs.readFileSync(process.argv[2], 'utf8').trim();
  fs.writeFileSync(process.argv[1], src.replace(re, 'export const RELEASE_PUBKEY =' + '\n  ' + q + pub + q + ';'));
" "$PUBKEY_TS" "$W/e2e.key.pub" || fail "could not patch RELEASE_PUBKEY"
(cd "$ROOT/packages/subshell-protocol" && bun run build >/dev/null) || fail "could not rebuild the protocol dist with the patched pubkey"
mkdir -p "$W/bin2"
# The SAME flags `bun run compile` uses (see step 2's note on why that is
# load-bearing). The compiled agent bundles the protocol package's DIST, so
# the rebuild above is what puts the throwaway armor inside this binary.
(cd "$NODE_APP" && bun build --compile --bytecode --minify --sourcemap ./src/main.ts \
   --outfile "$W/bin2/subshell" >/dev/null) || fail "could not build the patched-pubkey binary"
# Restore the source, rebuild the dist FROM it, and retire the backup only
# after the rebuild succeeded. Retiring it first was the ordering bug: `fail`
# exits, cleanup() gates its dist-rebuild branch on this variable, and a
# shared checkout left holding a throwaway-pubkey DIST is exactly what the
# several-sessions rule exists to prevent — the next bare `bun run compile`
# would bundle the fake publisher identity.
cp "$PUBKEY_BACKUP" "$PUBKEY_TS"
(cd "$ROOT/packages/subshell-protocol" && bun run build >/dev/null) || fail "could not rebuild the protocol dist from the restored source"
rm -f "$PUBKEY_BACKUP" && PUBKEY_BACKUP=""
"$W/bin2/subshell" version | grep -q "subshell $CURRENT" || fail "the patched-pubkey binary does not report $CURRENT"
cp "$W/bin2/subshell" "$W/bin2/subshell.patched"
ok "compiled a $CURRENT agent holding a throwaway publisher pubkey (source and dist restored)"

# The release the throwaway key signs: manifest bytes written FIRST, the
# armor made OVER them, and the fake source serves exactly those bytes —
# the canonical-bytes rule (§3) is part of what is under test, so nothing
# here may re-serialize the manifest on the way out.
mkdir -p "$W/rel"
cat > "$W/write-manifest.ts" <<EOF
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostReleaseTarget, releaseAssetNames } from "$ROOT/packages/subshell-protocol/src/releases.js";
const [binPath, version, outPath] = process.argv.slice(2);
const binary = releaseAssetNames("cli-node", hostReleaseTarget(process.platform, process.arch)!).binary;
const digest = createHash("sha256").update(readFileSync(binPath!)).digest("hex");
writeFileSync(outPath!, JSON.stringify({
  component: "cli-node",
  version: version!,
  nodeProtocol: 12,
  minNodeVersion: "0.11.0",
  commit: "0".repeat(40),
  assets: { [binary]: digest },
}));
EOF
bun "$W/write-manifest.ts" "$W/next-subshell" "$NEXT" "$W/rel/release-manifest.json" >/dev/null \
  || fail "could not write the throwaway release manifest"
bunx @tauri-apps/cli signer sign "$W/rel/release-manifest.json" -f "$W/e2e.key" -p e2epass >/dev/null \
  || fail "could not sign the throwaway release manifest"
bun -e "
  const fs = require('node:fs');
  const t = fs.readFileSync(process.argv[1], 'utf8');
  const d = t.match(/[0-9a-f]{64}/)[0];
  fs.writeFileSync(process.argv[2], t.replace(d, (d[0] === '0' ? '1' : '0') + d.slice(1)));
" "$W/rel/release-manifest.json" "$W/rel/tampered-manifest.json" \
  || fail "could not tamper the throwaway release manifest"

cat > "$W/fake-release-signed.ts" <<EOF
import { readFileSync } from "node:fs";
import { hostReleaseTarget, releaseAssetNames } from "$ROOT/packages/subshell-protocol/src/releases.js";
const binary = releaseAssetNames("cli-node", hostReleaseTarget(process.platform, process.arch)!).binary;
const [binPath, portArg, version, manifestPath, sigPath] = process.argv.slice(2);
const bytes = readFileSync(binPath!);
const manifest = readFileSync(manifestPath!);
const sig = readFileSync(sigPath!, "utf8");
const port = Number(portArg!);
const base = \`http://127.0.0.1:\${port}\`;
// The single lie: a sidecar digest the signed manifest does NOT name. No
// code path may treat it as verification (§4), and an install that succeeds
// is the proof none did.
const sidecar = "0".repeat(64) + "  " + binary + "\n";
Bun.serve({
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/releases") {
      return Response.json([
        {
          tag_name: \`cli-node-v\${version}\`,
          draft: false,
          assets: [
            { name: "release-manifest.json", browser_download_url: \`\${base}/manifest\` },
            { name: "release-manifest.json.sig", browser_download_url: \`\${base}/sig\` },
            { name: binary, browser_download_url: \`\${base}/bin\` },
            { name: \`\${binary}.sha256\`, browser_download_url: \`\${base}/sidecar\` },
          ],
        },
      ]);
    }
    if (path === "/manifest") return new Response(manifest);
    if (path === "/sig") return new Response(sig);
    if (path === "/bin") return new Response(bytes);
    if (path === "/sidecar") return new Response(sidecar);
    return new Response("no", { status: 404 });
  },
});
console.log("fake signed release source listening");
EOF

bun "$W/fake-release-signed.ts" "$W/next-subshell" "$ACC_PORT" "$NEXT" \
  "$W/rel/release-manifest.json" "$W/rel/release-manifest.json.sig" > "$W/signed.log" 2>&1 &
ACC_PID=$!
for _ in $(seq 1 60); do grep -q "listening" "$W/signed.log" && break; sleep 0.25; done
grep -q "listening" "$W/signed.log" || { cat "$W/signed.log"; fail "signed fake release source never started"; }
SUBSHELL_RELEASE_URL="http://127.0.0.1:$ACC_PORT/releases" \
  "$W/bin2/subshell" update --to "$NEXT" --yes --no-restart >"$W/signed.out" 2>&1 || {
    cat "$W/signed.out"; fail "the compiled agent refused a release its own compiled-in throwaway key signs";
  }
"$W/bin2/subshell" version | grep -q "subshell $NEXT" || fail "the signed release did not swap the binary"
[ -f "$W/bin2/subshell.previous" ] || fail ".previous was not kept by the signed swap"
grep -q "\"to\": \"$NEXT\"" "$W/data/update-pending.json" || fail "no marker names $NEXT after the signed swap"
ls "$W/bin2/"subshell.download-* >/dev/null 2>&1 && fail "the signed swap left a download temp behind"
kill "$ACC_PID" 2>/dev/null
ok "installed the throwaway-signed release on the signed digest — the lying sidecar changed nothing"

# Same armor, manifest flipped in one digest hex AFTER signing: the armor no
# longer covers those bytes, and the answer must be a refusal by name.
# Restoring the CURRENT bytes onto the live path can intermittently meet
# ETXTBSY: the `version` probes above have exited, but the kernel can hold an
# exec'd inode's last reference a few milliseconds longer, and cp onto a
# still-mapped file refuses. A short retry is the same rule `dev:install`
# learned (it stages beside the path and renames); the assertion this step
# exists for is what the TAMPERED run below must NOT do, and that runs
# against a settled file either way.
cp_ok=""
for _ in 1 2 3 4 5 6 7 8; do
  cp "$W/bin2/subshell.patched" "$W/bin2/subshell" 2>"$W/cp.err" && { cp_ok=1; break; }
  sleep 0.25
done
[ -n "$cp_ok" ] || { cat "$W/cp.err"; fail "could not restore the CURRENT binary onto the live path"; }
rm -f "$W/data/update-pending.json" "$W/bin2/subshell.previous"
bun "$W/fake-release-signed.ts" "$W/next-subshell" "$TAMP_PORT" "$NEXT" \
  "$W/rel/tampered-manifest.json" "$W/rel/release-manifest.json.sig" > "$W/tampered.log" 2>&1 &
TAMP_PID=$!
for _ in $(seq 1 60); do grep -q "listening" "$W/tampered.log" && break; sleep 0.25; done
grep -q "listening" "$W/tampered.log" || { cat "$W/tampered.log"; fail "tampered fake release source never started"; }
SUBSHELL_RELEASE_URL="http://127.0.0.1:$TAMP_PORT/releases" \
  "$W/bin2/subshell" update --to "$NEXT" --yes --no-restart >"$W/tampered.out" 2>&1 && \
  fail "a manifest tampered after signing was installed"
grep -qi "not installable" "$W/tampered.out" || { cat "$W/tampered.out"; fail "the tampered refusal did not name the release un-installable"; }
"$W/bin2/subshell" version | grep -q "subshell $CURRENT" || fail "the tampered update replaced the binary"
[ -f "$W/data/update-pending.json" ] && fail "the tampered refusal left a marker"
[ -f "$W/bin2/subshell.previous" ] && fail "the tampered refusal left a .previous"
kill "$TAMP_PID" 2>/dev/null
ok "refused the same release with one signed byte tampered — nothing downloaded, nothing replaced"

echo
echo "ALL NODE UPDATE CHECKS PASSED"
echo "workdir: $W"
