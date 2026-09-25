#!/usr/bin/env bash
# The compiled-server `mcp` smoke, ONE contract in ONE place — consumed by
# .github/workflows/test.yml (dev-compiled binary) and release.yml (the
# exec-smoked triples: the binary must RUN here, per the usage note below).
# It re-implements nothing of the binary; it asserts its refusal contract:
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
# Usage: smoke-mcp-refusal.sh <binary>
#   Every caller spawns bare, on a runner whose ISA hosts the binary: the
#   darwin-x64 release shard once refused "under Rosetta" behind a
#   translation prefix, and that venue was hopeless anyway — its own crash
#   banner proved an Apple Silicon runner cannot run this bun build at all
#   (SSE4.2 ceiling vs AVX2 need). The shard reaches this script natively
#   now, on GitHub's hosted Intel macOS runner.
set -euo pipefail

BIN="$(realpath "$1")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

set +e
out="$(env -i PATH="$PATH" HOME="$tmp" "$BIN" mcp </dev/null 2>&1)"
code=$?
set -e

[ "$code" -ne 0 ] || { echo "mcp subcommand unexpectedly exited 0"; exit 1; }
echo "$out"
printf '%s' "$out" | grep -q "SUBSHELL_API_KEY" || { echo "mcp refused for the wrong reason (output above)"; exit 1; }
if [ -e "$tmp/data" ]; then echo "mcp refusal created a data/ dir in the CWD"; exit 1; fi
echo "mcp refusal smoke OK: $BIN serves its own mcp subcommand (clean refusal, no litter)"
