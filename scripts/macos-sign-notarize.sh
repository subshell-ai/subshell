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
ENTITLEMENTS="$(cd -- "$(dirname "$0")" && pwd)/macos-entitlements.plist"

[ "$(uname -s)" = "Darwin" ] || { echo "sign-hook: refusing to sign $BIN on $(uname -s)" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "sign-hook: missing $ENTITLEMENTS" >&2; exit 1; }

# Hardened runtime + secure timestamp: both are notarization requirements.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$BIN"
codesign --verify --strict --verbose=2 "$BIN"

# Upload and block for the verdict; notarytool exits non-zero on rejection,
# which the caller maps to "this target failed". --wait prints the submission
# log into the CI output for the record.
xcrun notarytool submit "$BIN" --keychain-profile "$PROFILE" --wait

echo "sign-hook: $BIN signed + notarized (Developer ID: $IDENTITY)"
