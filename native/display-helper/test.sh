#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native display helper tests require macOS."
  exit 0
fi
source_dir="$(cd "$(dirname "$0")" && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/subshell-helper-tests.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
sources=()
for source in "$source_dir"/*.swift; do
  [[ "$(basename "$source")" == main.swift ]] || sources+=("$source")
done
xcrun swiftc -warnings-as-errors -target "$(uname -m)-apple-macos14.0" "${sources[@]}" "$source_dir/tests/HelperTests.swift" -o "$build_dir/tests"
# The test build cannot include `main.swift`, so this typechecks the module the desktop
# build actually compiles: every source here, main.swift included, and no test file. It
# catches a type error in the app delegate on this job rather than waiting for a desktop
# build on another one. Flags match `build_support.rs`, which passes only `-O` plus a
# macos14.0 target and no `-warnings-as-errors`; `-typecheck` needs neither output nor
# optimization.
app_sources=()
for source in "$source_dir"/*.swift; do
  app_sources+=("$source")
done
xcrun swiftc -typecheck -target "$(uname -m)-apple-macos14.0" "${app_sources[@]}"
"$build_dir/tests"
