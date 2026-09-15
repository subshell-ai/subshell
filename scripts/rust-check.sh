#!/usr/bin/env bash
#
# Run exactly what CI's Rust jobs run — `cargo fmt --check`, then
# `cargo clippy --all-targets -- -D warnings`, then `cargo test` — across
# `crates/desktop-core` and both Tauri apps.
#
# This exists because the two app crates CANNOT be compiled from a clean
# checkout. `tauri-build` refuses to build when an `externalBin` path is
# missing, and the staged sidecar is a gitignored ~110 MB build input, so
# `cargo clippy` in `apps/server/desktop/src-tauri` dies in the build script
# rather than reporting a lint. CI works around it by staging a STUB
# (.github/workflows/test.yml, "Stage a stub sidecar"); nothing did so
# locally, which is how a formatting failure reached CI instead of being
# caught in two seconds — the shape of bug this script exists to prevent.
#
# A stub is sound for these three commands: `tauri-build` only checks that the
# path EXISTS, and none of the Rust logic under test executes the sidecar. The
# real bundle, with a real binary inside it, is proven separately by
# scripts/smoke-desktop-bundle.sh on the release shards.
#
#   bun run rust:check
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Before any cargo runs: on a Mac whose Xcode licence is unaccepted, `cc`
# cannot link, and cargo buries that under an error naming a source file. Same
# bug class as the one in this file's header — a prerequisite whose failure
# names something else — so it is refused here instead of diagnosed there.
"$ROOT/scripts/macos-toolchain-preflight.sh"

TRIPLE="$(rustc --print host-tuple)"

# dir : sidecar stem. The same pairing lives in test.yml's matrix and in each
# app's tauri.conf.json; the stem names the binary the app WRAPS, not the app.
APPS=(
  "apps/server/desktop:subshell-server-bundled"
  "apps/client/desktop:subshell-node-bundled"
)

# Only stubs THIS run created, so a REAL sidecar staged by a release in
# progress is never deleted out from under it.
declare -a STAGED=()

cleanup() {
  for stub in ${STAGED[@]+"${STAGED[@]}"}; do rm -f "$stub"; done
}
trap cleanup EXIT

run_crate() {
  local dir="$1"
  echo "==> $dir"
  (
    cd "$dir"
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test
  )
}

run_crate "$ROOT/crates/desktop-core"

for entry in "${APPS[@]}"; do
  dir="${entry%%:*}"
  sidecar="${entry##*:}"
  bin_dir="$ROOT/$dir/src-tauri/binaries"
  stub="$bin_dir/$sidecar-$TRIPLE"
  mkdir -p "$bin_dir"
  if [ -e "$stub" ]; then
    echo "==> $dir: using the sidecar already staged at $sidecar-$TRIPLE"
  else
    install -m 755 /dev/null "$stub"
    STAGED+=("$stub")
    echo "==> $dir: staged a STUB sidecar ($sidecar-$TRIPLE), removed on exit"
  fi
  run_crate "$ROOT/$dir/src-tauri"
done

echo
echo "✓ fmt, clippy (-D warnings) and tests pass in all three Rust crates"
