#!/usr/bin/env bash
# The test runner @internal/server's `test` script wraps.
#
# Owns the run's throwaway tmux namespace: TMUX_TMPDIR is set for the whole
# `bun test` (children inherit the STARTUP env - a preload cannot re-home it
# later, measured on bun 1.4.2), so tmux resolves `-L <name>` under it and
# "which servers did this run start" is a directory listing. This file lived
# inside `src/test-preload.ts`'s afterAll until issue #261: under
# `bun test --parallel` a preload afterAll fires after EVERY file (measured
# on 1.4.0), and a sweep scoped by directory would kill the panes of sibling
# workers still mid-suite. The script runs after every worker has exited,
# serial or parallel.
#
# The DB-file sweep stays in the preload: it is scoped by this process's PID
# prefix, so a per-file firing is exactly its right moment there.
set -u
dir="$(mktemp -d /tmp/subshell-test-tmux-XXXXXX)"
status=0
TMUX_TMPDIR="$dir" bun test --timeout 30000 src "$@" || status=$?
if command -v tmux >/dev/null 2>&1; then
  for sock in "$dir"/tmux-*/*; do
    [ -e "$sock" ] || continue
    tmux -L "${sock##*/}" kill-server 2>/dev/null
  done
fi
rm -rf "$dir"
exit "$status"
