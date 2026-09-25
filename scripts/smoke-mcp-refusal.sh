#!/usr/bin/env bash
# The compiled-server `mcp` smoke, ONE contract in ONE place — consumed by
# .github/workflows/test.yml (dev-compiled binary) and release.yml (each
# release triple, darwin included). It re-implements nothing of the binary;
# it asserts its refusal contract:
#
#   1. `mcp` WITHOUT the pane env exits NON-ZERO (the env-contract refusal),
#   2. the refusal names SUBSHELL_API_KEY (the human-actionable half of
#      mcp-core's env.ts error — the grep anchor; keep in sync with it),
#   3. the refusal writes no data/ dir into the CWD (the CLI path does no
#      boot-graph IO),
#   4. the refusal is deterministic under a CLEAN env: `env -i` keeps any
#      leaked SUBSHELL_* pane env out of the child — the self-hosted release
#      runners RUN this product, and a future pane-env variable can never
#      silently flip the expected refusal into a connect attempt.
#
# Usage: smoke-mcp-refusal.sh <binary> [exec-prefix]
#   exec-prefix: optional command prefix, word-split by design. The release
#                darwin-x64 shard passes `arch -x86_64` so the cross-built
#                Intel binary is refused UNDER Rosetta, proving the refusal is
#                not an artifact of the translation. Everything else passes it
#                empty and spawns bare.
set -euo pipefail

BIN="$(realpath "$1")"
PREFIX="${2:-}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

set +e
out="$($PREFIX env -i PATH="$PATH" HOME="$tmp" "$BIN" mcp </dev/null 2>&1)"
code=$?
set -e

[ "$code" -ne 0 ] || { echo "mcp subcommand unexpectedly exited 0"; exit 1; }
echo "$out"
printf '%s' "$out" | grep -q "SUBSHELL_API_KEY" || { echo "mcp refused for the wrong reason (output above)"; exit 1; }
if [ -e "$tmp/data" ]; then echo "mcp refusal created a data/ dir in the CWD"; exit 1; fi
echo "mcp refusal smoke OK: $BIN serves its own mcp subcommand (clean refusal, no litter)"
