#!/usr/bin/env bash
# Smoke one published apps/desktop bundle.
#
# Usage: scripts/smoke-desktop-bundle.sh <triple> <version> <dist-dir>
#
# Deliberately does NOT launch the GUI: that needs xvfb on the Linux runner and
# would be the flakiest step in the pipeline. What it checks instead is
# everything that can be wrong WITHOUT launching — the artifact set, the
# digests, the nested sidecar (present, executable, and named the way Tauri
# actually names it), the Debian dependencies, and on macOS the full signing
# chain including the staple, which Tauri applies without ever checking whether
# it worked.
set -euo pipefail

TRIPLE="${1:?usage: smoke-desktop-bundle.sh <triple> <version> <dist-dir>}"
VERSION="${2:?missing version}"
DIST="${3:?missing dist dir}"

fail() {
  echo "smoke: $*" >&2
  exit 1
}

# The in-bundle name has NO triple suffix — Tauri strips it on copy, so
# anything grepping for the staged name finds nothing 100% of the time.
SIDECAR="subshell-server-bundled"

case "$TRIPLE" in
  linux-x64) ARTIFACT="Subshell_${VERSION}_amd64.deb" ;;
  darwin-arm64) ARTIFACT="Subshell.app.tar.gz" ;;
  *) fail "unknown triple '$TRIPLE'" ;;
esac

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$TRIPLE" = "linux-x64" ]; then
  echo "smoke: inspecting the .deb"
  dpkg-deb -c "$DIST/$ARTIFACT" >"$WORK/contents"
  grep -q "/usr/bin/$SIDECAR\$" "$WORK/contents" || fail "the sidecar is not at /usr/bin/$SIDECAR"
  # A sidecar staged from a zip artifact loses its mode and ships 0644, which
  # dies EACCES at exec — invisible until first run.
  grep -E "^-rwxr-xr-x .*/usr/bin/$SIDECAR\$" "$WORK/contents" >/dev/null \
    || fail "the sidecar is not 0755 in the package"

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
  ver="$("$WORK/root/usr/bin/$SIDECAR" version || true)"
  case "$ver" in "subshell-server "*) ;; *) fail "the bundled sidecar cannot report a version: $ver" ;; esac
  # The glibc floor the container chose is the app's minimum supported Linux.
  # Recording it makes a silent floor bump visible in the log.
  if command -v objdump >/dev/null 2>&1; then
    echo -n "smoke: highest GLIBC symbol required: "
    objdump -T "$WORK/root/usr/bin/subshell-desktop" 2>/dev/null \
      | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 || echo "(none found)"
  fi
  exit 0
fi

echo "smoke: extracting the app bundle"
tar xzf "$DIST/$ARTIFACT" -C "$WORK"
APP="$WORK/Subshell.app"
[ -d "$APP" ] || fail "the tarball does not contain Subshell.app"

# An AppleDouble member that survives into the archive breaks the extracted
# bundle's signature, and the failure looks like a signing bug rather than a
# packaging one.
members="$(tar tzf "$DIST/$ARTIFACT")"
case "$members" in *"/._"*) fail "the archive carries AppleDouble (._) members" ;; esac

[ -x "$APP/Contents/MacOS/$SIDECAR" ] || fail "the sidecar is missing or not executable inside the bundle"
ver="$("$APP/Contents/MacOS/$SIDECAR" version || true)"
case "$ver" in "subshell-server "*) ;; *) fail "the bundled sidecar cannot report a version: $ver" ;; esac

echo "smoke: verifying the signature chain"
codesign --verify --deep --strict --verbose=2 "$APP" || fail "codesign --verify failed"
# The sidecar must carry the hardened runtime too, or its entitlements are inert.
sig="$(codesign -dvv "$APP/Contents/MacOS/$SIDECAR" 2>&1 || true)"
case "$sig" in *"flags="*"runtime"*) ;; *) fail "the sidecar is not signed with the hardened runtime" ;; esac
assess="$(spctl -a -vvv -t exec "$APP" 2>&1 || true)"
case "$assess" in *"source=Notarized Developer ID"*) ;; *) fail "Gatekeeper does not see a notarized Developer ID app: $assess" ;; esac
# Tauri's staple_app calls .output() and never inspects the exit status, so a
# stapling failure is SILENT and the build still reports success.
xcrun stapler validate "$APP" || fail "the notarization ticket is not stapled"

echo "smoke: ok"
