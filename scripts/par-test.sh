#!/usr/bin/env bash
# Injects (or omits) bun test's --parallel flag for every package's `test` script.
#
# Default is parallel N (first argument; per-package, measured). Two overrides:
# SUBSHELL_TEST_PARALLEL changes the width, and SUBSHELL_TEST_SERIAL=1 omits
# the flag entirely - which CI does. CI's omission is not caution: bun's
# --parallel=1 is NOT serial (it still implies --isolate, re-importing each
# file's modules), and the hosted container runs on a fraction of its 4 labels
# (0.4 CPU, measured in apps/server/web's 2026-09-17 budgets and again
# 2026-09-30, where width 1 stretched a 2.5 s react-act chain past 25 s). The
# suite-level budgets starve at any worker width there; serial is the regime
# that passes. Developers get the width; CI gets determinism.
#
# The flag must be omittable, and neither bun's script shell (no ${VAR:+}) nor
# a package.json string can express omission - hence a script, called as
#   bash "$(git rev-parse --show-toplevel)/scripts/par-test.sh" <N> bun test ...
set -u
n="$1"
shift
if [ -n "${SUBSHELL_TEST_PARALLEL:-}" ]; then n="$SUBSHELL_TEST_PARALLEL"; fi
# Insert the flag where bun test parses it: after `bun test`, before the rest.
prog="$1"
sub="$2"
shift 2
if [ -z "${SUBSHELL_TEST_SERIAL:-}" ]; then set -- --parallel="$n" "$@"; fi
exec "$prog" "$sub" "$@"
