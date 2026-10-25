#!/usr/bin/env bash
# Build a stable app identity so macOS can attribute the probe's permissions.
set -euo pipefail
umask 077

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Build this probe on the Mac that will run BetterDisplay." >&2
  exit 1
fi
if [[ $# -lt 1 || $# -gt 2 || "$1" != /*.app || -e "$1" || -z "${2:--}" ]]; then
  echo "Pass a new absolute .app path and, optionally, your code-signing identity." >&2
  exit 1
fi

probe_sources="$(cd "$(dirname "$0")" && pwd)"
probe_destination="$1"
probe_signing_identity="${2:--}"
mkdir -p "$(dirname "$probe_destination")"
probe_staging="$(mktemp -d "$(dirname "$probe_destination")/.display-probe.XXXXXX")"
trap 'rm -rf "$probe_staging"' EXIT
probe_bundle="$probe_staging/Subshell Display Probe.app"
mkdir -p "$probe_bundle/Contents/MacOS"

cat > "$probe_bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>sh.subshell.display-probe</string>
  <key>CFBundleName</key><string>Subshell Display Probe</string>
  <key>CFBundleDisplayName</key><string>Subshell Display Probe</string>
  <key>CFBundleExecutable</key><string>DisplayProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

/usr/bin/swiftc -O -target "$(uname -m)-apple-macos14.0" \
  "$probe_sources/DisplayProbe.swift" -o "$probe_bundle/Contents/MacOS/DisplayProbe"
/usr/bin/codesign --force --sign "$probe_signing_identity" --identifier sh.subshell.display-probe "$probe_bundle"
mv "$probe_bundle" "$probe_destination"
echo "Built $probe_destination"
