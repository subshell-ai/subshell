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
#
# --parallel (issue #261): worker processes for the run's files. Default 12,
# measured on this repo's suite at 48 cores; SUBSHELL_TEST_PARALLEL overrides
# it (CI pins 4 for its 4-core runners - 12 starved the web suite's wall-clock
# timeouts there). bunfig's `parallel` key is silently ignored by bun (1.4.0
# and 1.4.2), so the flag lives here and in every package's `test` script, and
# a bare hand-typed `bun test` stays serial (the preload above still applies
# to it). Trailing args pass through to `bun test` (CI appends --shard for
# its matrix legs).
set -u
dir="$(mktemp -d /tmp/subshell-test-tmux-XXXXXX)"
status=0
TMUX_TMPDIR="$dir" bun test --parallel="${SUBSHELL_TEST_PARALLEL:-12}" --timeout 30000 src "$@" || status=$?
if command -v tmux >/dev/null 2>&1; then
  for sock in "$dir"/tmux-*/*; do
    [ -e "$sock" ] || continue
    tmux -L "${sock##*/}" kill-server 2>/dev/null
  done
fi
rm -rf "$dir"
exit "$status"
