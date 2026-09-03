#!/bin/bash
# Sign + notarize ONE Mach-O release artifact, in place.
#
# CI sets SUBSHELL_RELEASE_SIGN_CMD to this script (darwin shards only); the
# release pipelines run it between the build and the digest, so the published
# .sha256 sidecar always describes the SIGNED bytes, and a refusal here fails
# the target — and a failed target publishes nothing.
#
# Credentials, in two modes:
#   CI (secrets-based, the release.yml darwin branch): the keychain holding
#   the "Developer ID Application" identity (with Apple's Developer ID G2
#   intermediate, or codesign cannot build the chain) is CREATED by the job
#   from MACOS_CERT_P12_BASE64, and notary credentials arrive via
#   SUBSHELL_NOTARY_KEY_PATH / _KEY_ID / _ISSUER_ID (an App Store Connect
#   API key). Nothing is read from, or persisted to, the host.
#   Manual/local (fallback): an identity in the login keychain plus a
#   notarytool keychain profile (SUBSHELL_NOTARY_PROFILE, default
#   "subshell-notary").
#
# After this script, a browser-downloaded binary passes Gatekeeper with the
# ordinary "downloaded from the internet" confirmation instead of the
# "damaged and can't be opened" refusal (unsigned + quarantined).
set -eu

BIN="${1:?usage: macos-sign-notarize.sh <binary-path>}"
IDENTITY="${SUBSHELL_CODESIGN_IDENTITY:-Developer ID Application: Disaresta, LLC (DVRYX6BV6J)}"
# Notary credentials: CI exports the API-key triple; otherwise fall back to
# the stored keychain profile (manual runs on a provisioned host).
if [ -n "${SUBSHELL_NOTARY_KEY_PATH:-}" ]; then
  [ -n "${SUBSHELL_NOTARY_KEY_ID:-}" ] && [ -n "${SUBSHELL_NOTARY_ISSUER_ID:-}" ] \
    || { echo "sign-hook: SUBSHELL_NOTARY_KEY_PATH needs _KEY_ID and _ISSUER_ID too" >&2; exit 1; }
  [ -f "$SUBSHELL_NOTARY_KEY_PATH" ] || { echo "sign-hook: notary key not found at $SUBSHELL_NOTARY_KEY_PATH" >&2; exit 1; }
  NOTARY_ARGS=(--key "$SUBSHELL_NOTARY_KEY_PATH" --key-id "$SUBSHELL_NOTARY_KEY_ID" --issuer "$SUBSHELL_NOTARY_ISSUER_ID")
else
  NOTARY_ARGS=(--keychain-profile "${SUBSHELL_NOTARY_PROFILE:-subshell-notary}")
fi
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
SUBMIT_LOG="$(xcrun notarytool submit "$ZIP" "${NOTARY_ARGS[@]}" --wait 2>&1)"
rm -f "$ZIP"
echo "$SUBMIT_LOG"
SUBMISSION_ID="$(printf '%s\n' "$SUBMIT_LOG" | sed -n 's/.*id: \([0-9a-f-]\{36\}\).*/\1/p' | head -1)"
if ! printf '%s\n' "$SUBMIT_LOG" | grep -q "status: Accepted"; then
  echo "sign-hook: NOTARIZATION REJECTED for $BIN (submission ${SUBMISSION_ID:-unknown})" >&2
  [ -n "$SUBMISSION_ID" ] && xcrun notarytool log "$SUBMISSION_ID" "${NOTARY_ARGS[@]}" /dev/stdout >&2 || true
  exit 1
fi

echo "sign-hook: $BIN signed + notarized (Developer ID: $IDENTITY)"
