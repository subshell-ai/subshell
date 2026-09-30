#!/usr/bin/env bash
# Regenerates the committed .bun-test-timings.json that CI's shard balancing
# reads: bun treats the per-file durations as a hint (it balances --shard by
# total time and makes --parallel start the slowest file first), so staleness
# costs ordering, never correctness.
#
# Run it after a big test wave, or when one shard leg of test-server-node
# starts finishing visibly ahead of its sibling. The two packages here are
# exactly the ones that job --shards; minutes, on purpose.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tfile="$root/.bun-test-timings.json"
cd "$root/apps/server/api" && ./scripts/test-run.sh --timings="$tfile" --update-timings
cd "$root/apps/node/agent" && bash "$root/scripts/par-test.sh" 12 bun test --timings="$tfile" --update-timings
echo "wrote $tfile"
