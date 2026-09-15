#!/usr/bin/env bash
#
# Refuse early, and by name, when this Mac's C toolchain cannot link.
#
# Every local command that compiles Rust (`bun run rust:check`, and the
# `tauri dev` launchers) depends on `cc` being able to produce a binary. When
# the Xcode licence has not been accepted it cannot, and the way that surfaces
# is the reason this file exists: cargo reports the licence text as a `note:`
# on a linker error roughly a hundred lines up, while the LAST thing printed —
# the part anyone reads first — is
#
#     Couldn't compile the test.
#     failures:
#         src/browser.rs - browser::browser_url (line 41)
#     error: doctest failed, to rerun pass `--doc`
#
# So a machine that cannot link anything reads as one broken doctest in a file
# somebody just edited. Measured on 2026-09-15, where it cost an afternoon's
# worth of wrong suspicion before the real note was found. It is the same shape
# as the defect `rust-check.sh` itself was written for: a prerequisite whose
# failure names something other than itself.
#
# It PROBES rather than asks `xcodebuild`, because the probe is the thing that
# actually has to work and it answers correctly under every way out of this:
# accepting the licence, or pointing `DEVELOPER_DIR` at the Command Line Tools,
# which selects a toolchain the licence gate does not cover.
#
# Non-darwin exits 0 immediately. A failure it does NOT recognise is reported
# verbatim rather than blamed on the licence — advice for the wrong problem is
# worse than none.
set -uo pipefail

[ "$(uname -s)" = "Darwin" ] || exit 0

# The real operation, as cheap as it gets: compile and link an empty
# translation unit. `-w` because an empty file warns under some SDKs.
probe_out="$(cc -w -x c -c /dev/null -o /dev/null 2>&1)"
probe_rc=$?
[ "$probe_rc" -eq 0 ] && exit 0

if printf '%s' "$probe_out" | grep -qi "license"; then
  cat >&2 <<'MSG'
This Mac's C toolchain cannot link: the Xcode licence has not been accepted,
so every cargo build here fails on `cc` — and says so a hundred lines up,
under an error that names a source file instead.

Accept it (needs sudo, so run it yourself):

    sudo xcodebuild -license

Or use the Command Line Tools toolchain instead, which the licence gate does
not cover:

    export DEVELOPER_DIR=/Library/Developer/CommandLineTools

MSG
  exit 1
fi

{
  echo "This Mac's C toolchain cannot link, so every cargo build here will fail."
  echo "This is NOT the Xcode licence (that failure names a licence; this one does not)."
  echo "\`cc -x c -c /dev/null\` said:"
  echo
  printf '%s\n' "$probe_out"
} >&2
exit 1
