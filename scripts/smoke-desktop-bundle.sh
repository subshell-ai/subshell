#!/usr/bin/env bash
# Smoke one published desktop bundle — either app.
#
# Usage: scripts/smoke-desktop-bundle.sh <app> <triple> <version> <dist-dir>
#   <app> is the release component id: desktop-server | desktop-client
#
# Deliberately does NOT launch the GUI: that needs xvfb on the Linux runner and
# would be the flakiest step in the pipeline. What it checks instead is
# everything that can be wrong WITHOUT launching — the artifact set, the
# digests, the nested sidecar (present, executable, and named the way Tauri
# actually names it), the Debian dependencies, and on macOS the full signing
# chain including the staple, which Tauri applies without ever checking whether
# it worked.
set -euo pipefail

APP="${1:?usage: smoke-desktop-bundle.sh <app> <triple> <version> <dist-dir>}"
TRIPLE="${2:?missing triple}"
VERSION="${3:?missing version}"
DIST="${4:?missing dist dir}"

fail() {
  echo "smoke: $*" >&2
  exit 1
}

# Everything that differs between the two bundles, in one table. The in-bundle
# sidecar name has NO triple suffix — Tauri strips it on copy, so anything
# grepping for the STAGED name finds nothing 100% of the time.
case "$APP" in
  desktop-server)
    PRODUCT="Subshell"
    SIDECAR="subshell-server-bundled"
    SIDECAR_PREFIX="subshell-server "
    MAIN_BIN="subshell-desktop"
    ;;
  desktop-client)
    PRODUCT="SubshellNode"
    SIDECAR="subshell-node-bundled"
    SIDECAR_PREFIX="subshell "
    MAIN_BIN="subshell-desktop-client"
    ;;
  *) fail "unknown app '$APP' (known: desktop-server, desktop-client)" ;;
esac

case "$TRIPLE" in
  linux-x64) ARTIFACT="${PRODUCT}_${VERSION}_amd64.deb" ;;
  darwin-arm64) ARTIFACT="${PRODUCT}.app.tar.gz" ;;
  *) fail "unknown triple '$TRIPLE'" ;;
esac

echo "smoke: $APP $TRIPLE — expecting $ARTIFACT"
[ -f "$DIST/$ARTIFACT" ] || fail "missing artifact $DIST/$ARTIFACT"
[ -f "$DIST/$ARTIFACT.sha256" ] || fail "missing digest sidecar for $ARTIFACT"

echo "smoke: verifying the published digest"
EXPECTED="$(cut -d' ' -f1 <"$DIST/$ARTIFACT.sha256")"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$DIST/$ARTIFACT" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$DIST/$ARTIFACT" | cut -d' ' -f1)"
fi
[ "$EXPECTED" = "$ACTUAL" ] || fail "digest mismatch: sidecar says $EXPECTED, file is $ACTUAL"

# The sidecar must be the real thing, not the stub the Rust CI job stages.
check_sidecar_runs() {
  ver="$("$1" version 2>/dev/null || true)"
  case "$ver" in
    "$SIDECAR_PREFIX"*) echo "smoke: bundled sidecar reports: $ver" ;;
    *) fail "the bundled sidecar cannot report a version (expected a line starting '$SIDECAR_PREFIX'): $ver" ;;
  esac
}

if [ "$TRIPLE" = "linux-x64" ]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  echo "smoke: inspecting the .deb"
  dpkg-deb -c "$DIST/$ARTIFACT" >"$WORK/contents"
  # Match on the LAST field rather than with a path regex. `dpkg-deb -c` prints
  # members as `usr/bin/x` on some versions and `./usr/bin/x` on others, and a
  # pattern anchored with a leading slash silently matches neither — which
  # reads as "the sidecar is missing" for a package that is perfectly correct.
  entry="$(awk -v p="usr/bin/$SIDECAR" '$NF == p || $NF == "./" p' "$WORK/contents")"
  if [ -z "$entry" ]; then
    # A bare "not found" is not actionable — the next question is always "then
    # what IS in there".
    echo "--- the package's full contents ---" >&2
    cat "$WORK/contents" >&2
    fail "the sidecar is not at usr/bin/$SIDECAR"
  fi
  # A sidecar staged from a zip artifact loses its mode and ships 0644, which
  # dies EACCES at exec — invisible until first run.
  case "$entry" in
    -rwxr-xr-x*) ;;
    *) fail "the sidecar is not 0755 in the package: $entry" ;;
  esac

  DEPENDS="$(dpkg-deb -f "$DIST/$ARTIFACT" Depends)"
  echo "smoke: Depends: $DEPENDS"
  for dep in libwebkit2gtk-4.1-0 libayatana-appindicator3-1; do
    case "$DEPENDS" in *"$dep"*) ;; *) fail "Depends is missing $dep" ;; esac
  done

  dpkg-deb -x "$DIST/$ARTIFACT" "$WORK/root"
  # Capture, then match. `grep -q` exits at the first hit and SIGPIPEs the
  # producer, which under `set -o pipefail` fails a check that just passed.
  magic="$(file "$WORK/root/usr/bin/$SIDECAR")"
  case "$magic" in *"ELF 64-bit"*"x86-64"*) ;; *) fail "the sidecar is not an x86-64 ELF: $magic" ;; esac
  # It is the whole point of the bundle — a sidecar that cannot run makes every
  # other check here decoration.
  check_sidecar_runs "$WORK/root/usr/bin/$SIDECAR"
  [ -f "$WORK/root/usr/bin/$MAIN_BIN" ] || fail "the app binary is not at usr/bin/$MAIN_BIN"
  # The glibc floor the container chose is the app's minimum supported Linux.
  # Recording it makes a silent floor bump visible in the log.
  if command -v objdump >/dev/null 2>&1; then
    echo -n "smoke: highest GLIBC symbol required: "
    objdump -T "$WORK/root/usr/bin/$MAIN_BIN" 2>/dev/null \
      | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 || echo "(none found)"
  fi
  echo "smoke: ok"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "smoke: extracting the app bundle"
tar xzf "$DIST/$ARTIFACT" -C "$WORK"
APP_BUNDLE="$WORK/$PRODUCT.app"
[ -d "$APP_BUNDLE" ] || fail "the tarball does not contain $PRODUCT.app"

# An AppleDouble member that survives into the archive breaks the extracted
# bundle's signature, and the failure looks like a signing bug rather than a
# packaging one.
members="$(tar tzf "$DIST/$ARTIFACT")"
case "$members" in *"/._"*) fail "the archive carries AppleDouble (._) members" ;; esac

[ -x "$APP_BUNDLE/Contents/MacOS/$SIDECAR" ] || fail "the sidecar is missing or not executable inside the bundle"
check_sidecar_runs "$APP_BUNDLE/Contents/MacOS/$SIDECAR"

echo "smoke: verifying the signature chain"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" || fail "codesign --verify failed"
# The sidecar must carry the hardened runtime too, or its entitlements are inert.
sig="$(codesign -dvv "$APP_BUNDLE/Contents/MacOS/$SIDECAR" 2>&1 || true)"
case "$sig" in *"flags="*"runtime"*) ;; *) fail "the sidecar is not signed with the hardened runtime" ;; esac
assess="$(spctl -a -vvv -t exec "$APP_BUNDLE" 2>&1 || true)"
case "$assess" in *"source=Notarized Developer ID"*) ;; *) fail "Gatekeeper does not see a notarized Developer ID app: $assess" ;; esac
# Tauri's staple_app calls .output() and never inspects the exit status, so a
# stapling failure is SILENT and the build still reports success.
xcrun stapler validate "$APP_BUNDLE" || fail "the notarization ticket is not stapled"

echo "smoke: ok"
