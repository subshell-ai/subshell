#!/usr/bin/env bash
# Subshell control plane installer.
#
#   curl -fsSL https://raw.githubusercontent.com/subshell-ai/subshell/main/install-server.sh | bash
#
# Downloads the `subshell-server` binary for this platform from the newest
# `server-vX.Y.Z` GitHub Release, VERIFIES its digest before the file is ever
# made executable, installs it to ~/.local/bin, and hands over to
# `subshell-server init` — which asks the setup questions and prints where to
# go next. This script deliberately says nothing about what comes after `init`:
# the CLI owns the questions and the handoff, the script owns the download
# (spec 2026-09-15 §3.1).
#
# Knobs, all optional and all read from the environment because a piped curl
# has no argv:
#   SUBSHELL_SERVER_VERSION          install this exact X.Y.Z instead of the newest
#   SUBSHELL_SERVER_RELEASE_API      releases listing URL (default: GitHub's)
#   SUBSHELL_SERVER_RELEASE_BASE     directory holding the release assets
#   SUBSHELL_SERVER_PORT             -> init --port
#   SUBSHELL_SERVER_HOST             -> init --host
#   SUBSHELL_SERVER_BASE_URL         -> init --base-url
#   SUBSHELL_SERVER_TRUSTED_ORIGINS  -> init --trusted-origins
#   SUBSHELL_NO_SERVICE=1            -> init --no-service
set -eu

REPO="subshell-ai/subshell"
BIN_DIR="$HOME/.local/bin"
DEST="$BIN_DIR/subshell-server"

fail() {
  echo "subshell-server: $1" >&2
  shift
  for line in "$@"; do
    echo "    $line" >&2
  done
  exit 1
}

# --- 1. which binary does this machine need? --------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)              TARGET="linux-x64" ;;
  Linux/aarch64|Linux/arm64) TARGET="linux-arm64" ;;
  Darwin/arm64)              TARGET="darwin-arm64" ;;
  Darwin/x86_64)
    # Refused BY NAME rather than resolved to a triple whose asset does not
    # exist. Intel Macs are not a published target for any component, so "the
    # release has no asset for darwin-x64" would read as "the release is
    # incomplete" — a different problem with a different fix.
    fail "Intel Macs are not supported: no server binary is published for darwin-x64." \
      "Apple silicon and Linux have binaries; on an Intel Mac, run the server from a checkout."
    ;;
  *)
    fail "unsupported platform: $OS/$ARCH" \
      "Published targets are linux-x64, linux-arm64 and darwin-arm64."
    ;;
esac

# --- 2. which release? ------------------------------------------------------
# The releases LISTING, not /releases/latest: this repo ships four components
# from one repo, so the newest release overall is as likely to be a node-v* or
# desktop-* cut as a server one. Tags are filtered to `server-v` and ordered
# with sort -V, which knows 1.10.0 > 1.9.0 and plain `sort` does not.
API="${SUBSHELL_SERVER_RELEASE_API:-https://api.github.com/repos/$REPO/releases}"

# Refuse a plaintext hop on the PUBLIC path — including a redirect into one,
# which `--location` would otherwise follow silently. Not applied when an
# operator has pointed this at their own API or asset host: an override is a
# deliberate choice about their own network, the same posture the plugin
# registry documents for an http mirror, and a test fake is exactly that.
CURL_PROTO="--proto =https --tlsv1.2"
case "${SUBSHELL_SERVER_RELEASE_API:-}${SUBSHELL_SERVER_RELEASE_BASE:-}" in
  "") ;;
  *) CURL_PROTO="" ;;
esac
VERSION="${SUBSHELL_SERVER_VERSION:-}"
if [ -z "$VERSION" ]; then
  echo "==> finding the newest server release"
  # No jq: a fresh headless box has curl and coreutils and frequently nothing
  # else. grep -o over the tag_name fields is enough for a flat list of tags,
  # and a tag that does not match the mint shape simply does not appear.
  if ! BODY="$(curl $CURL_PROTO --silent --show-error --location --fail "$API")"; then
    fail "could not reach the release index at $API" \
      "Check outbound network, or pass SUBSHELL_SERVER_VERSION=X.Y.Z to skip this lookup."
  fi
  VERSION="$(
    printf '%s' "$BODY" |
      grep -o '"tag_name"[[:space:]]*:[[:space:]]*"server-v[0-9][0-9.]*"' |
      sed -e 's/.*"server-v//' -e 's/"$//' |
      sort -V |
      tail -n 1
  )"
  if [ -z "$VERSION" ]; then
    fail "no server-vX.Y.Z release is published yet." \
      "The index at $API listed no matching tag."
  fi
fi
TAG="server-v$VERSION"
echo "==> installing $TAG ($TARGET)"

ASSET="subshell-server-cli-$TARGET"
BASE="${SUBSHELL_SERVER_RELEASE_BASE:-https://github.com/$REPO/releases/download/$TAG}"

# --- 3. download ------------------------------------------------------------
mkdir -p "$BIN_DIR"
TMP="$DEST.part"
rm -f "$TMP" "$TMP.sha256"

# The HTTP code is inspected rather than curl's exit status alone: "404, this
# release has no asset for your platform" and "the network is down" need
# different advice, and an exit-status-only guard says the same thing for both.
echo "==> downloading $ASSET"
if ! HTTP="$(curl $CURL_PROTO --silent --show-error --location "$BASE/$ASSET" \
  --output "$TMP" --write-out '%{http_code}')"; then
  rm -f "$TMP"
  fail "could not download $BASE/$ASSET; nothing was installed." \
    "Check outbound network access to the release host."
fi
case "$HTTP" in
  200) ;;
  404)
    rm -f "$TMP"
    fail "$TAG publishes no $TARGET binary (asset $ASSET is missing)." \
      "Published targets are linux-x64, linux-arm64 and darwin-arm64." \
      "Pick another release with SUBSHELL_SERVER_VERSION=X.Y.Z, or build from a checkout."
    ;;
  *)
    rm -f "$TMP"
    fail "the release host answered HTTP $HTTP for $ASSET; nothing was installed."
    ;;
esac

# --- 4. verify BEFORE anything is made executable ---------------------------
# The sidecar is a BARE 64-hex digest, so the "<hash>  <file>" line the -c
# checkers want is paired here rather than downloaded. Verifying before the
# first chmod +x is what makes `curl | bash` sound: nothing this script fetched
# can run until its bytes match the digest the release published.
#
# Be precise about what that buys, because it reads stronger than it is: the
# digest comes from the SAME host as the binary, so it bounds a corrupt
# download and a bad mirror, and NOT a compromised release host — which would
# serve a matching pair. Transport integrity is the `--proto '=https'` below;
# provenance beyond that would need a signature this project does not yet
# publish.
if ! EXPECTED="$(curl $CURL_PROTO --silent --show-error --location --fail "$BASE/$ASSET.sha256" | tr -d '[:space:]')"; then
  rm -f "$TMP"
  fail "could not fetch the checksum for $ASSET; nothing was installed."
fi
if [ -z "$EXPECTED" ]; then
  rm -f "$TMP"
  fail "the checksum for $ASSET was empty; nothing was installed."
fi
printf '%s  %s\n' "$EXPECTED" "$TMP" > "$TMP.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  VERIFY="sha256sum -c"
elif command -v shasum >/dev/null 2>&1; then
  VERIFY="shasum -a 256 -c"
else
  rm -f "$TMP" "$TMP.sha256"
  fail "need sha256sum or shasum to verify the download; nothing was installed."
fi
echo "==> verifying checksum"
if ! $VERIFY "$TMP.sha256" >/dev/null; then
  rm -f "$TMP" "$TMP.sha256"
  fail "checksum mismatch for $ASSET: corrupt download or a tampered mirror." \
    "Nothing was installed and nothing was executed."
fi
rm -f "$TMP.sha256"

# --- 5. install -------------------------------------------------------------
# mv onto $DEST, THEN chmod: an interrupted download can never leave a partial
# executable where the service definition expects a server.
mv -f "$TMP" "$DEST"
chmod +x "$DEST"
echo "==> installed $DEST"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "==> note: $BIN_DIR is not on your PATH. Add it with:"
    echo "        export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# tmux is what every local subshell's pane runs under. This is a warning and
# not a refusal because `init` has its own preflight that OFFERS to install it,
# and refusing here would take that offer away.
if ! command -v tmux >/dev/null 2>&1; then
  echo "==> note: tmux is not installed. Subshell needs it to run panes on this host;"
  echo "        the next step offers to install it."
fi

# --- 6. hand over to the CLI ------------------------------------------------
# Every one of these is an `if` and not a `test && append`. Not because `&&`
# would abort — measured on bash, sh and dash, `set -e` is ignored for a
# non-last command of an AND-OR list and a short-circuited list does not exit
# the shell. It is that `test && arr+=(...)` makes the LIST's status the
# statement's status, so the last knob being unset leaves the script's exit
# code at 1 if nothing follows it, and a reader has to know that rule to see
# the difference. An `if` says what it does and owes nothing to `set -e`.
INIT_ARGS=()
if [ -n "${SUBSHELL_SERVER_PORT:-}" ]; then INIT_ARGS+=(--port "$SUBSHELL_SERVER_PORT"); fi
if [ -n "${SUBSHELL_SERVER_HOST:-}" ]; then INIT_ARGS+=(--host "$SUBSHELL_SERVER_HOST"); fi
if [ -n "${SUBSHELL_SERVER_BASE_URL:-}" ]; then INIT_ARGS+=(--base-url "$SUBSHELL_SERVER_BASE_URL"); fi
if [ -n "${SUBSHELL_SERVER_TRUSTED_ORIGINS:-}" ]; then
  INIT_ARGS+=(--trusted-origins "$SUBSHELL_SERVER_TRUSTED_ORIGINS")
fi
if [ "${SUBSHELL_NO_SERVICE:-}" = "1" ]; then INIT_ARGS+=(--no-service); fi

# A piped curl leaves stdin reading the SCRIPT, so `init`'s questions would
# each get EOF and take their default with nobody having been asked. Point
# stdin back at the terminal when there demonstrably is one. Written as an
# `if` because the `&&` spelling would leave a headless run's exit status at 1
# if this were the last statement — not, as is often assumed, because `set -e`
# aborts on a short-circuited AND-OR list; it does not, on bash, sh or dash.
if [ -t 1 ] && [ -r /dev/tty ]; then
  exec < /dev/tty
fi

# A piped-curl install is a distribution and the recipient never sees a LICENSE
# file — what lands is one bare binary. Naming the terms once, and pointing at
# the subcommand that prints them in full, is the only moment this path has to
# do that. The control plane is AGPL-3.0-only, NOT Apache-2.0 like the rest of
# the repo: apps/server/** is the copyleft half of the split (root AGENTS.md,
# "The licence boundary IS this directory line").
echo "    Copyright 2026 Disaresta, LLC. AGPL-3.0-only, with the API Type Surface"
echo "    exception. Run \"$DEST\" license for the full notice."

# The last word belongs to `init`: it asks about the background service and
# prints the "open <url>/setup" handoff. Nothing is echoed after it.
exec "$DEST" init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"}
