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
"$build_dir/tests"
