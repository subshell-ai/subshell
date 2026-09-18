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
#   3. first admin + a setup key;
#   4. the node one-liner it serves installs and enrols a node against it;
#   5. the newest published `node-v*` release's manifest verifies OFFLINE
#      against the pubkey compiled into the products (spec 2026-09-17) — the
#      one thing step 4's lazy fetch cannot prove, because THAT server
#      verifies against its own embedded key, and both would fail
#      identically if the cut had shipped no signature at all.
# Temp dirs, a throwaway HOME, port 31997. Never ~/.config/subshell-server or :3080.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
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

echo "== 5. the published node release verifies OFFLINE against RELEASE_PUBKEY"
# Why this step is not covered by step 4's lazy fetch: that fetch verifies
# against the key EMBEDDED IN THE RELEASED SERVER — and the released server
# and the release itself ship from one repo, so if a cut somehow published an
# unsigned or wrong-key manifest, the released plane's answer and this
# checkout's answer could drift. This verifies against THIS working tree's
# compile-time pubkey — the one future installs bake — over the raw published
# bytes, exactly as an installed product will on its next update.
NODE_TAG=$(curl -fsSL "https://api.github.com/repos/subshell-ai/subshell/tags?per_page=100" \
  | grep -o '"name": *"node-v[^"]*"' | sed 's/.*: *"\(.*\)"/\1/' | sort -V | tail -1)
[ -n "$NODE_TAG" ] || fail "no node-v* tag found on the public repo"
cat > "$W/verify-manifest.ts" <<EOF
import { RELEASE_PUBKEY } from "$REPO/packages/subshell-protocol/src/releases.js";
import { verifyReleaseManifest } from "$REPO/packages/subshell-protocol/src/release-signature.js";
const [version, tag] = process.argv.slice(2);
if (!version || !tag) { console.error("usage: verify-manifest.ts <version> <tag>"); process.exit(1); }
const base = "https://github.com/subshell-ai/subshell/releases/download/" + tag + "/";
const mf = await fetch(base + "release-manifest.json");
if (!mf.ok) { console.error("release-manifest.json: HTTP " + mf.status + " — the newest node release carries no manifest (it predates signed releases)"); process.exit(1); }
const sg = await fetch(base + "release-manifest.json.sig");
if (!sg.ok) { console.error("release-manifest.json.sig: HTTP " + sg.status + " — an UNSIGNED release: no plane will offer it for update"); process.exit(1); }
const res = await verifyReleaseManifest(new Uint8Array(await mf.arrayBuffer()), await sg.text(), RELEASE_PUBKEY, { component: "node", version });
if (!res.ok) { console.error("REFUSED: " + res.reason); process.exit(1); }
console.log("verified " + res.manifest.component + " " + res.manifest.version + " — " + Object.keys(res.manifest.assets).length + " signed asset(s)");
EOF
bun "$W/verify-manifest.ts" "${NODE_TAG#node-v}" "$NODE_TAG" || fail "the published node release does not verify against this build's RELEASE_PUBKEY"
ok "$NODE_TAG verifies against the compile-time publisher pubkey"

echo
echo "RELEASE E2E PASSED"
