#!/usr/bin/env bash
#
# The headless CLI end-to-end suite: it drives the REAL compiled binaries the
# way an operator does, which nothing else here covers.
#
# `bun run test` is source-level and every service seam in it is stubbed, so
# the one thing it cannot answer is whether `init`, `setup` and the rendered
# installer actually work when compiled — the failures that only appear in a
# binary (a bundler dropping a module, a prompt that hangs without a TTY, a
# handoff line nobody prints) live exactly here. `e2e/` is the browser suite
# and boots the server from source, so it does not cover this either.
#
# Both cases use temp config/data dirs, a throwaway HOME and ports 31998/31999.
# They never touch ~/.config/subshell-server or :3080 — the operator's live
# instance — and each tears its own server down from a trap.
#
#   bun run test:cli        (compiles both binaries first)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

echo "==> compiling both CLIs"
(cd "$ROOT/apps/server/api" && bun run compile >/dev/null)
(cd "$ROOT/apps/node/agent" && bun run compile >/dev/null)

# published-release.sh is deliberately NOT run here: it needs the public
# internet and a real release, so it is the post-cut check, run by hand.
"$HERE/headless-server-and-node.sh"
echo
"$HERE/install-script.sh"
echo
"$HERE/server-update.sh"
echo
"$HERE/node-update.sh"
echo
echo "✓ headless CLI end-to-end suite passed"
