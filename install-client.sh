#!/usr/bin/env bash
# Subshell Client installer.
#
#   curl -fsSL https://subshell.sh/install-client.sh | bash
#
# Downloads the Subshell Client DESKTOP app for this platform from the newest
# `desktop-client-vX.Y.Z` GitHub Release, verifies its SHA-256 sidecar BEFORE
# anything touches /Applications or the package database, and installs it.
# The app, not a CLI binary — the vocabulary holds; the node agent rides
# inside this bundle and enrolling it happens inside the app.
#
# Version truth comes from the repo's releases.json (never the GitHub API):
# the same file the marketing site reads, so "what the site says" and "what
# this installs" cannot disagree (spec 2026-09-23 §6).
#
# Knobs (piped curl has no argv), all optional:
#   SUBSHELL_CLIENT_VERSION       install this exact X.Y.Z instead of the newest
#   SUBSHELL_CLIENT_YES=1         replace an existing "Subshell Client.app"
#   SUBSHELL_CLIENT_MANIFEST_URL  releases.json location (default: the repo's)
#   SUBSHELL_CLIENT_RELEASE_BASE  directory holding the release assets
#   SUBSHELL_CLIENT_TARGET        override platform resolution (test/exotic hosts)
#   SUBSHELL_CLIENT_APPS_DIR      where the .app lands (default: /Applications)
set -eu

REPO="subshell-ai/subshell"
MANIFEST_URL="${SUBSHELL_CLIENT_MANIFEST_URL:-https://raw.githubusercontent.com/$REPO/main/releases.json}"

fail() {
  echo "subshell-client: $1" >&2
  shift
  for line in "$@"; do
    echo "    $line" >&2
  done
  exit 1
}

# --- 1. which bundle does this machine need? ---------------------------------
# Desktop targets are NOT the CLI's four (spec 2026-09-23 §6): there is no
# linux-arm64 desktop build — no native runner, and a GUI cannot be
# magic-checked into confidence. Intel Macs DO get the app: the pipeline
# cross-builds the darwin-x64 bundle with tauri `--target`. Any other
# platform is refused BY NAME so the message is that fact rather than a 404
# the reader misattributes to a broken release.
if [ -n "${SUBSHELL_CLIENT_TARGET:-}" ]; then
  TARGET="$SUBSHELL_CLIENT_TARGET"
else
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "$OS/$ARCH" in
    Darwin/arm64)  TARGET="darwin-arm64" ;;
    Darwin/x86_64) TARGET="darwin-x64" ;;
    Linux/x86_64)  TARGET="linux-x64" ;;
    *)
      fail "unsupported platform: $OS/$ARCH" \
        "Subshell Client is published for darwin-arm64, darwin-x64 and linux-x64."
      ;;
  esac
fi
case "$TARGET" in
  darwin-arm64|darwin-x64|linux-x64) ;;
  *)
    fail "unsupported target: $TARGET" \
      "Subshell Client is published for darwin-arm64, darwin-x64 and linux-x64."
    ;;
esac

# --- 2. which release? (releases.json, never the API) ------------------------
# No jq: a freshly booted desktop has curl and the baseutils and frequently
# nothing else (the same constraint install-server.sh works under), so the
# manifest is sliced with grep/sed.
#
# The transport pin is decided PER FETCH, from the URL that fetch is about to
# hit: `--location` follows redirects, so without `--proto =https` a release
# host could bounce a download into plaintext and the script would follow.
# An https endpoint stays pinned no matter what else is overridden; a
# non-https endpoint exists only because an operator or a test harness named
# it — a deliberate choice about their own network, the same posture
# install-server.sh takes for any override, and what lets
# install-client-script.test.ts drive a fake release host at http://127.0.0.1.
proto_for() {
  case "$1" in
    https://*) echo "--proto =https --tlsv1.2" ;;
    *) echo "" ;;
  esac
}

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

MANIFEST_PROTO="$(proto_for "$MANIFEST_URL")"
if ! curl $MANIFEST_PROTO --silent --show-error --location --fail "$MANIFEST_URL" -o "$TMPD/releases.json"; then
  fail "could not fetch the release manifest from $MANIFEST_URL" \
    "Check outbound network, or pass SUBSHELL_CLIENT_VERSION=X.Y.Z to skip the lookup."
fi

# schemaVersion must be exactly 1: an unknown shape is refused rather than
# half-parsed. The extraction stops at the first character that cannot
# continue the number, so a future schemaVersion 10 is not taken for 1.
SCHEMA="$(grep -m1 '"schemaVersion"' "$TMPD/releases.json" \
  | sed -e 's/.*"schemaVersion"[[:space:]]*:[[:space:]]*//' -e 's/[,}"[:space:]].*$//')"
if [ "$SCHEMA" != "1" ]; then
  fail "unrecognized releases.json (schemaVersion 1 expected); nothing was installed."
fi

VERSION="${SUBSHELL_CLIENT_VERSION:-}"
if [ -z "$VERSION" ]; then
  echo "==> finding the newest Subshell Client release"
  # Slice out the desktop-client object and take its version. Anchoring on
  # the component key is the whole point: one manifest lists all four
  # components, and a newer cli-server cut must not steer this download the
  # way `sort -V | tail -1` over the raw file would.
  VERSION="$(sed -n '/"desktop-client"[[:space:]]*:[[:space:]]*{/,/}/p' "$TMPD/releases.json" \
    | grep -m1 '"version"' \
    | sed -e 's/.*"version"[[:space:]]*:[[:space:]]*"//' -e 's/".*$//')"
  if [ -z "$VERSION" ]; then
    fail "the release manifest lists no desktop-client release yet; nothing was installed."
  fi
fi
TAG="desktop-client-v$VERSION"
echo "==> installing Subshell Client $TAG ($TARGET)"

# --- 3. asset names, exactly as this repo publishes them ----------------------
# The names are `desktopArtifactFileName` in @internal/subshell-protocol: the
# `Desktop` marker is what keeps a DMG apart from the CLI binaries in the
# same downloads space, and the .deb spelling is Tauri's lower-cased slug.
# The Mac spelling is `<slug>-<version>-<triple>.dmg`, so one $TARGET covers
# both Apple silicon and Intel — the same formula `desktopArtifactFileName`
# publishes under.
case "$TARGET" in
  darwin-*) ASSET="Subshell-Client-Desktop-$VERSION-$TARGET.dmg" ;;
  *)        ASSET="subshell-client-desktop_${VERSION}_amd64.deb" ;;
esac
BASE="${SUBSHELL_CLIENT_RELEASE_BASE:-https://github.com/$REPO/releases/download/$TAG}"
ASSET_PROTO="$(proto_for "$BASE")"

# --- 4. download and verify BEFORE installing ---------------------------------
# The HTTP code is inspected rather than curl's exit status alone, and the
# sidecar is a BARE 64-hex digest so the "<hash>  <file>" line the -c
# checkers want is paired here — both exactly as install-server.sh does it,
# for the same reasons (a 404 needs different advice from a dead network;
# only the digest's SOURCE makes the pairing meaningful). What the check
# bounds is a corrupt download and a bad mirror, not a compromised release
# host — that is the honest accounting at install-server.sh, and it holds
# here identically.
echo "==> downloading $ASSET"
if ! HTTP="$(curl $ASSET_PROTO --silent --show-error --location "$BASE/$ASSET" \
  --output "$TMPD/$ASSET" --write-out '%{http_code}')"; then
  fail "could not download $BASE/$ASSET; nothing was installed."
fi
case "$HTTP" in
  200) ;;
  404)
    fail "$TAG publishes no $TARGET bundle (asset $ASSET is missing)." \
      "Current published desktop targets are darwin-arm64, darwin-x64 and linux-x64;" \
      "older releases may carry fewer."
    ;;
  *)
    fail "the release host answered HTTP $HTTP for $ASSET; nothing was installed."
    ;;
esac
# Fetch and trim are TWO steps on purpose: without pipefail, `curl --fail |
# tr` inside a command substitution reports tr's success no matter what the
# release host answered, so a 404 sidecar would fall through to the hex check
# and blame the mirror's content for its absence. The fetch names a missing
# sidecar; only a DELIVERED one can then be judged not-a-digest.
if ! curl $ASSET_PROTO --silent --show-error --location --fail "$BASE/$ASSET.sha256" -o "$TMPD/sidecar.sha256"; then
  fail "could not fetch the checksum for $ASSET; nothing was installed."
fi
EXPECTED="$(tr -d '[:space:]' < "$TMPD/sidecar.sha256")"
case "$EXPECTED" in
  *[!0-9a-fA-F]*|"") fail "the checksum for $ASSET was not a hex digest; nothing was installed." ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  VERIFY="sha256sum -c"
elif command -v shasum >/dev/null 2>&1; then
  VERIFY="shasum -a 256 -c"
else
  fail "need sha256sum or shasum to verify the download; nothing was installed."
fi
printf '%s  %s\n' "$EXPECTED" "$TMPD/$ASSET" > "$TMPD/$ASSET.sha256"
echo "==> verifying checksum"
if ! $VERIFY "$TMPD/$ASSET.sha256" >/dev/null; then
  fail "checksum mismatch for $ASSET: corrupt download or a tampered mirror; nothing was installed and nothing was executed."
fi

# --- 5. install ---------------------------------------------------------------
# Everything above wrote only inside $TMPD: every refusal so far changed
# nothing on this machine, which is what the test harness asserts by way of
# the shims never having been called.
if [ "${TARGET#darwin-}" != "$TARGET" ]; then
  APPS_DIR="${SUBSHELL_CLIENT_APPS_DIR:-/Applications}"
  STAGED="$APPS_DIR/Subshell Client.app"
  # The spaced name is the bundle's real identity — the published FILE is
  # space-free because it is a download URL, the installed app is not.
  if [ -e "$STAGED" ] && [ "${SUBSHELL_CLIENT_YES:-}" != "1" ]; then
    fail "Subshell Client is already installed at $STAGED." \
      "Re-run with SUBSHELL_CLIENT_YES=1 to replace it: curl -fsSL <this-url> | SUBSHELL_CLIENT_YES=1 bash"
  fi
  MNT="$TMPD/mnt"
  mkdir -p "$MNT"
  if ! hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMPD/$ASSET"; then
    fail "could not mount $ASSET; nothing was installed."
  fi
  # detach on ANY exit after attach: the trap above cleans the temp dir, but
  # a mounted image would linger in Finder until macOS reclaimed it.
  trap 'hdiutil detach -quiet "$MNT" 2>/dev/null || true; rm -rf "$TMPD"' EXIT
  if [ ! -d "$MNT/Subshell Client.app" ]; then
    fail "the mounted image contains no \"Subshell Client.app\"; nothing was installed."
  fi
  echo "==> installing to $STAGED"
  rm -rf "$STAGED"
  cp -R "$MNT/Subshell Client.app" "$APPS_DIR/"
  # A busy unmount AFTER a successful copy is not a failed install: the app
  # is already in place, and macOS reclaims the mount on its own.
  hdiutil detach -quiet "$MNT" || true
  trap 'rm -rf "$TMPD"' EXIT
  echo "==> installed Subshell Client — launch it from Applications."
else
  # The .deb goes through the package manager, never dpkg -i by hand:
  # apt resolves dependencies and records ownership, so the app is a
  # distro-managed package the moment it lands.
  if [ "$(id -u)" = "0" ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    # No fabricating an install: print the exact command instead of
    # invoking a package manager that is not there.
    fail "installing the .deb needs root; no sudo was found." \
      "Run this as root, or: sudo apt-get install -y \"$TMPD/$ASSET\""
  fi
  echo "==> installing the package (the package manager may ask for a password)"
  if ! $SUDO apt-get install -y "$TMPD/$ASSET"; then
    fail "apt-get refused; nothing was changed."
  fi
  echo "==> installed Subshell Client — launch it from your applications menu."
fi

# The client app bundles the node agent; it enrolls through the control plane,
# so there is no `init` handoff here. One pointer, then done.
echo "    Sign in to your control plane inside the app to connect this machine."
