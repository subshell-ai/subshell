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

# The minimum glibc both apps are built against, chosen by the builder image
# (ubuntu:24.04) rather than inherited from whatever the runner was last
# re-imaged with. Bumping the image means bumping this AND the deb.depends in
# both tauri.conf.json files — the support statement is Ubuntu 24.04+ /
# Debian 13+.
GLIBC_FLOOR="2.39"

# Everything that differs between the two bundles, in one table.
#
# Three names per app, and they are deliberately three:
#
#   PRODUCT  `productName` — what the bundler CALLS the `.app` (and the volume)
#            INSIDE the disk image, spaces included. That is the app the user
#            installs and what the bundle identifier belongs to, so every path
#            built from it is quoted here.
#   DMG      the PUBLISHED macOS asset name, version and triple included.
#            Space-free, because it is a download URL and a shell argument, and
#            chosen by the repo (`desktopArtifactFileName`) rather than read off
#            the bundler.
#   PKG      the PUBLISHED Debian file-name stem — lowercase, as a Debian
#            package name has to be.
#
# The release script globs the bundle directory for whatever Tauri emitted and
# renames it to the published name, which is why these two do not have to be
# guessable from PRODUCT.
#
# The in-bundle sidecar name has NO triple suffix — Tauri strips it on copy, so
# anything grepping for the STAGED name finds nothing 100% of the time.
case "$APP" in
  desktop-server)
    PRODUCT="Subshell Server"
    DMG_SLUG="Subshell-Server-Desktop"
    PKG="subshell-server-desktop"
    SIDECAR="subshell-server-bundled"
    SIDECAR_PREFIX="subshell-server "
    MAIN_BIN="subshell-desktop"
    ;;
  desktop-client)
    PRODUCT="Subshell Client"
    DMG_SLUG="Subshell-Client-Desktop"
    PKG="subshell-client-desktop"
    SIDECAR="subshell-node-bundled"
    SIDECAR_PREFIX="subshell "
    MAIN_BIN="subshell-desktop-client"
    ;;
  *) fail "unknown app '$APP' (known: desktop-server, desktop-client)" ;;
esac

# Both Mac triples ship a DMG, named `<slug>-<version>-<triple>.dmg` — the
# same formula `desktopArtifactFileName` publishes under, with the triple
# spelled ONCE here from $TRIPLE so a new Mac arch cannot quietly keep the
# arm64 name.
case "$TRIPLE" in
  linux-x64) ARTIFACT="${PKG}_${VERSION}_amd64.deb" ;;
  darwin-arm64|darwin-x64) ARTIFACT="${DMG_SLUG}-${VERSION}-${TRIPLE}.dmg" ;;
  *) fail "unknown triple '$TRIPLE'" ;;
esac
DMG="$ARTIFACT"

# The UPDATER artifact for this triple (spec 2026-09-15 § 8). macOS ships a
# tarball of the `.app` beside the image the human downloads; Linux's update
# package IS the `.deb`, handed to dpkg by the plugin. So there is a second
# file on one platform and not on the other, and the manifest has to name
# whichever it is.
case "$TRIPLE" in
  linux-x64) UPDATER_ASSET="$ARTIFACT" ;;
  darwin-arm64|darwin-x64) UPDATER_ASSET="${DMG%.dmg}.app.tar.gz" ;;
esac
MANIFEST="latest.${TRIPLE}.json"

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

# The updater half. Every failure it catches has the SAME symptom on a user's
# machine — an installed app that says "no updates" forever — and none of them
# is an error anywhere in the pipeline, which is exactly why they are asserted
# here rather than discovered later.
echo "smoke: checking the updater manifest and its artifact"
[ -f "$DIST/$MANIFEST" ] || fail "missing $MANIFEST (did the release script write the shard manifest?)"
[ -f "$DIST/$UPDATER_ASSET" ] || fail "missing updater artifact $UPDATER_ASSET"
[ -f "$DIST/$UPDATER_ASSET.sha256" ] || fail "missing digest sidecar for $UPDATER_ASSET"

# The manifest must name a file that EXISTS, under the name it will be
# published as. A manifest naming the bundler's own spelling — or a name the
# rename step changed afterwards — downloads a 404 on every machine.
grep -q "/$UPDATER_ASSET\"" "$DIST/$MANIFEST" \
  || { echo "--- $MANIFEST ---" >&2; cat "$DIST/$MANIFEST" >&2; fail "$MANIFEST does not name $UPDATER_ASSET"; }
# And a SIGNATURE that is actually there: an empty one publishes cleanly and is
# refused by every installed app.
grep -q '"signature": *"[^"]' "$DIST/$MANIFEST" || fail "$MANIFEST carries an empty signature"
# Tauri's own platform spelling, not this repo's. A manifest keyed
# `darwin-arm64` parses, uploads, and then matches nothing.
case "$TRIPLE" in
  linux-x64) PLATFORM_KEY="linux-x86_64" ;;
  darwin-arm64) PLATFORM_KEY="darwin-aarch64" ;;
  darwin-x64) PLATFORM_KEY="darwin-x86_64" ;;
esac
grep -q "\"$PLATFORM_KEY\"" "$DIST/$MANIFEST" || fail "$MANIFEST does not key this platform as $PLATFORM_KEY"
# The version in it must be the one being cut, or the plugin compares an
# installed app against the wrong number.
grep -q "\"version\": *\"$VERSION\"" "$DIST/$MANIFEST" || fail "$MANIFEST is not version $VERSION"

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
  # Match on the END OF THE LINE, not on a field. `dpkg-deb -c` puts the path
  # last, and $NF is the last WHITESPACE-SEPARATED field — so any in-package
  # path containing a space silently never matches. This package ships one:
  # `usr/share/applications/Subshell Client.desktop`, whose $NF is
  # `Client.desktop`. The two paths checked here happen to be space-free, so
  # the old field match worked by luck rather than by design.
  #
  # The leading space in the pattern anchors it to the start of the path field,
  # so a longer path ending in the same name cannot match.
  entry=""
  while IFS= read -r line; do
    case "$line" in
      *" usr/bin/$SIDECAR" | *" ./usr/bin/$SIDECAR") entry="$line"; break ;;
    esac
  done <"$WORK/contents"
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
  # Tauri generates Depends from the linked libraries and adds NO libc6 entry
  # and no version constraints at all — so without the manual one from
  # tauri.conf.json, this package installs cleanly on Ubuntu 22.04 and then
  # dies at exec with "GLIBC_2.39 not found". The manual dep turns a confusing
  # runtime crash into a clean dpkg refusal, and it is invisible unless
  # asserted: the release that shipped without it passed every other check.
  case "$DEPENDS" in
    *"libc6 (>= $GLIBC_FLOOR)"*) ;;
    *) fail "Depends carries no 'libc6 (>= $GLIBC_FLOOR)' — the .deb would install on an older glibc and die at exec" ;;
  esac

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
MNT="$WORK/mnt"
mkdir -p "$MNT"
# The detach belongs in the cleanup: a failed check between attach and the
# script's end must not leave the volume mounted on the runner forever.
cleanup() {
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "smoke: mounting the disk image"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DIST/$ARTIFACT" >/dev/null
# The published image name is space-free; the `.app` inside it is NOT — it
# carries the product name a user sees. Every path derived from it is quoted.
APP_BUNDLE="$MNT/$PRODUCT.app"
if [ ! -d "$APP_BUNDLE" ]; then
  echo "--- the mounted volume's contents ---" >&2
  ls -la "$MNT" >&2 || true
  fail "the image does not contain '$PRODUCT.app'"
fi

echo "smoke: verifying the image container"
# The container is what the user downloads and what Gatekeeper assesses BEFORE
# the app ever runs — a signed, notarized app inside an unattested image is
# still blocked on first launch. codesign on a .dmg checks its outer signature;
# the staple on the IMAGE (not just the app) is the ticket that answers offline.
codesign --verify --strict --verbose=2 "$DIST/$ARTIFACT" || fail "codesign --verify failed on the image"
# Tauri only signs the image; the release pipeline itself notarizes and staples
# it (notarizeAndStapleDmg). This validates that step from the OUTSIDE — the
# same posture that caught Tauri's app-staple step never checking its own
# exit status.
xcrun stapler validate "$DIST/$ARTIFACT" || fail "the notarization ticket is not stapled to the image"

[ -x "$APP_BUNDLE/Contents/MacOS/$SIDECAR" ] || fail "the sidecar is missing or not executable inside the bundle"
# The arch of the nested sidecar is the one thing a mislabeled build would
# get wrong, so the Mach-O slice is asserted first — and then it RUNS, both
# Mac triples alike. Each darwin shard is smoked on hardware that IS its
# arch (arm64 on the Apple Silicon label, x86_64 on the hosted Intel one),
# and that venue is what makes the run check honest. It was always the
# venue, not the check: the x64 bundle on an Apple Silicon runner could
# never pass it — that image's Rosetta ceiling is SSE4.2 while bun's x86_64
# build needs AVX2, settled by the cross-built sidecar's own crash banner
# (run 36196527394: `CPU: sse42 popcnt`).
case "$TRIPLE" in
  darwin-arm64) MACHO_HINT="arm64" ;;
  darwin-x64) MACHO_HINT="x86_64" ;;
esac
sidecar_magic="$(file "$APP_BUNDLE/Contents/MacOS/$SIDECAR")"
case "$sidecar_magic" in
  *"Mach-O"*"$MACHO_HINT"*) ;;
  *) fail "the sidecar is not a $MACHO_HINT Mach-O: $sidecar_magic" ;;
esac
# The sidecar is a CLI, not the GUI: this exec is not the launch this
# script's header declines to do, and it is the whole point of the bundle.
check_sidecar_runs "$APP_BUNDLE/Contents/MacOS/$SIDECAR"

echo "smoke: verifying the merged Info.plist"
# `src-tauri/Info.plist` is merged into the bundle's own by tauri-cli's macOS
# bundling settings (tauri-cli 2.11.4 interface/rust.rs: the file plus the
# bundle.macOS.infoPlist object), and NOTHING else proves that merge survived
# to the outside. The four sentences below are the ones macOS prints INSIDE
# the permission sheets this app raises; a dropped key is not a build failure,
# it is a sheet with no reason or a privacy-access crash, checked only at a
# user's first access. (The operator's 2026-09-25 Photos hunt is why this
# assertion exists: the plist was right, and only reading the bundler proved
# it — that proof now runs on every darwin cut.)
for KEY in NSPhotoLibraryUsageDescription \
           NSDesktopFolderUsageDescription \
           NSDocumentsFolderUsageDescription \
           NSDownloadsFolderUsageDescription; do
  VAL="$(plutil -extract "$KEY" raw "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true)"
  [ -n "$VAL" ] || fail "the bundle's Info.plist is missing $KEY — the src-tauri merge did not reach the bundle"
done

echo "smoke: verifying the signature chain"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" || fail "codesign --verify failed"
# The sidecar must carry the hardened runtime too, or its entitlements are inert.
sig="$(codesign -dvv "$APP_BUNDLE/Contents/MacOS/$SIDECAR" 2>&1 || true)"
case "$sig" in *"flags="*"runtime"*) ;; *) fail "the sidecar is not signed with the hardened runtime" ;; esac
assess="$(spctl -a -vvv -t exec "$APP_BUNDLE" 2>&1 || true)"
case "$assess" in *"source=Notarized Developer ID"*) ;; *) fail "Gatekeeper does not see a notarized Developer ID app: $assess" ;; esac

echo "smoke: ok"
