#!/bin/sh
# Sign + notarize ONE Mach-O release artifact, in place.
#
# CI sets SUBSHELL_RELEASE_SIGN_CMD to this script (darwin shards only); the
# release pipelines run it between the build and the digest, so the published
# .sha256 sidecar always describes the SIGNED bytes, and a refusal here fails
# the target — and a failed target publishes nothing.
#
# Requirements in the signing user's login keychain on the build host:
#   - a "Developer ID Application" identity (+ its private key, with the
#     Apple Developer ID G2 intermediate installed, or codesign cannot build
#     the chain), reachable without a GUI prompt (set-key-partition-list),
#   - a notarytool keychain profile (see SUBSHELL_NOTARY_PROFILE below).
#
# After this script, a browser-downloaded binary passes Gatekeeper with the
# ordinary "downloaded from the internet" confirmation instead of the
# "damaged and can't be opened" refusal (unsigned + quarantined).
set -eu

BIN="${1:?usage: macos-sign-notarize.sh <binary-path>}"
IDENTITY="${SUBSHELL_CODESIGN_IDENTITY:-Developer ID Application: Disaresta, LLC (DVRYX6BV6J)}"
PROFILE="${SUBSHELL_NOTARY_PROFILE:-subshell-notary}"
# NOTE: macos-entitlements.plist must carry NO XML comments — codesign parses
# entitlements through AMFI's strict plist parser, which rejects them
# ("Failed to parse entitlements: AMFIUnserializeXML: syntax error").
ENTITLEMENTS="$(cd -- "$(dirname "$0")" && pwd)/macos-entitlements.plist"

[ "$(uname -s)" = "Darwin" ] || { echo "sign-hook: refusing to sign $BIN on $(uname -s)" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "sign-hook: missing $ENTITLEMENTS" >&2; exit 1; }

# Hardened runtime + secure timestamp: both are notarization requirements.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$BIN"
codesign --verify --strict --verbose=2 "$BIN"

# Notarize via a ZIP WRAPPER: Apple's service rejects raw Mach-O even with
# --force ("not a supported archive file format" / "no signed executables or
# bundles" — measured, submission 9d3f36e8). The ticket binds to the binary's
# cdhash, so we notarize the zip and still distribute the BARE file:
# Gatekeeper resolves it via Apple's online check. (The zip is throwaway.)
ZIP="${BIN}.notary.zip"
rm -f "$ZIP"
(cd "$(dirname "$BIN")" && zip -q -X "$ZIP" "$(basename "$BIN")")

# Block for the verdict. MEASURED on notarytool 1.1.2: --wait exits 0 even
# when the verdict is Invalid, so the VERDICT STRING is the assertion —
# parsed from the submit output, never inferred from the exit code.
SUBMIT_LOG="$(xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait 2>&1)"
rm -f "$ZIP"
echo "$SUBMIT_LOG"
SUBMISSION_ID="$(printf '%s\n' "$SUBMIT_LOG" | sed -n 's/.*id: \([0-9a-f-]\{36\}\).*/\1/p' | head -1)"
if ! printf '%s\n' "$SUBMIT_LOG" | grep -q "status: Accepted"; then
  echo "sign-hook: NOTARIZATION REJECTED for $BIN (submission ${SUBMISSION_ID:-unknown})" >&2
  [ -n "$SUBMISSION_ID" ] && xcrun notarytool log "$SUBMISSION_ID" --keychain-profile "$PROFILE" /dev/stdout >&2 || true
  exit 1
fi

echo "sign-hook: $BIN signed + notarized (Developer ID: $IDENTITY)"
