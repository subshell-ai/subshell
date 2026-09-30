# Parallel test runs (issue #261)

Date: 2026-09-29. Branch: `feat/parallel-tests`.

## Problem and evidence

`bun run test` is `turbo run test`: parallel *across* the 52 packages, but
inside each package `bun test` runs its files serially. 763 test files;
`apps/server/api` (270 files, real SQLite, real tmux) is the long pole.
Measured on a 48-core dev machine, serial vs. `bun test --parallel`:

| Package | serial | parallel | parallel failures |
|---|---|---|---|
| apps/server/api | 115.6 s | 47.9 s (N=8) | 56 |
| apps/server/web | 58.8 s | 11.3 s (N=12) | 0 |
| packages/pane-runtime | 18.7 s | 13.9 s (N=12) | 0 |
| apps/node/agent | 13.6 s | 6.0 s (N=12) | 0 |

CI (`.github/workflows/test.yml`) runs on GitHub-hosted 4-core
`ubuntu-24.04` runners, sharded by package group.

## Mechanism

`--parallel=N` lives in every package's `test` **script** (inside
`apps/server/api/scripts/test-run.sh` for the server). Bun spawns N
workers, distributes files, and isolates each file's module registry
(`--isolate`, implied). Worker count is capped by file count, so small
packages self-limit. N: **12** for `server/api`, `server/web`,
`node/agent`; **4** elsewhere. Tunable after first green.

The design started from `bunfig.toml` — the flag there would reach every
invocation, the same rationale each package's `preload` lives there for.
Measured during implementation: bun silently IGNORES a `parallel`
key in bunfig's `[test]` (no PARALLEL banner, serial timings; measured on
1.4.0 and again on 1.4.2, to which the dev machine was upgraded mid-work -
CI's builder image already ran 1.4.2). [bun.com/docs/test](https://bun.com/docs/test)
lists `parallel` as a CLI flag only. A bare hand-typed `bun test` therefore
stays serial, which is the safe default: the preload still reaches it, and
nothing correctness-relevant depends on the flag.

## Measured runner semantics (Bun 1.4.0, probed)

- A preload-registered `afterAll` fires **once per run in serial** but
  **after every file under `--parallel`**.
- Serial mode shares one module cache across files; parallel mode gives
  each file a fresh registry. Both are load-bearing for how today's
  suites pass and must stay pinned by what we learn here.
- Post-startup `process.env` writes do NOT reach children spawned via
  `bun:spawn` without an explicit `env` (a preload cannot re-home
  `TMUX_TMPDIR` for children).

## Hazards fixed before the flag lands (PR 1)

1. **The tmux sweep** (`server/api` preload): kills every tmux server
   under the run's shared `TMUX_TMPDIR`. Under parallel it would fire
   per file and kill sibling workers' live panes. Fix: move kill-all +
   temp-dir removal into the package's test script (a small shell
   script that owns the directory, runs after every worker exits, and
   preserves the exit code). The preload keeps its per-PID DB sweep,
   which is parallel-safe as measured.

2. **Implicit migration ordering** (`server/api`): five files query the
   shared `@/db` singleton (directly or through service imports) without
   running migrations, surviving serially because files that run earlier
   migrated the process-wide shared DB. Fresh per-file DBs under parallel
   expose it as `no such table`. Fix: an explicit `ensureMigratedTestDb()`
   helper (Kysely + better-auth migrations) called in each affected
   suite's `beforeAll`, plus `prepareLocalPlugins()` alongside it in the
   MCP suite (the auto-restart gate reads the plugin store and silently
   defers on an unseeded one). Idempotent, so serial stays green.
   Two of the original 14 failing suites
   (`subshell-manager.service.test.ts`'s live-pane cases) turned out to be
   hazard 1's collateral, not a DB problem; the one `bootstrap argv`
   failure reproduces SERIALLY under the dev shell's `SHELLOPTS` export
   and is an environment artifact, not parallel-related.

4. **Ordering shuffle**: parallel changes which files share a worker.
   Latent env-mutation leaks surface as flakes; the bake below is the
   control, not a static audit of 763 files.

## CI (PR 2)

`test-server-node` becomes a 2-way `--shard` matrix (turbo arg passthrough
appends `--shard=1/2` to each filtered package's run; each job runs one
half). One committed per-file durations JSON (bun's `--timings`) lets bun
balance the shards and start the slowest files first; a root
`test:timings` script refreshes it locally. Other shards get re-measured
after PR 1; split another job only if a real long pole remains.

## Verification

- Per-cluster reproducers before fixes (two-file parallel runs).
- PR 1 gate: full `bun run test` three consecutive green runs locally at
  the chosen N (passed on 1.4.2, 51/51 tasks each), one serial
  (`--parallel=1`) run proving the sweep move kept serial semantics, and
  `verify-types`/`lint:check`/`lint:prose`/`test:scripts`.
- Flake policy: any package that fails the bake gets its `N` set back to
  `1` and rejoins later.
- What CI's first run of PR 1 found (4-core hosted runner, N=12): three
  `Test: web` wall-clock timeouts (a pure-logic test measured 6 s against
  bun's 5 s default) and one real race in `daemon.test.ts` that waited on
  one settle-unlink and peeked the other. Fixes: per-runner width via
  `SUBSHELL_TEST_PARALLEL` (scripts default to their N, CI pins 4; local
  48 cores keep 12/4), and the daemon test now waits for both unlinks.
  No package fell back to `parallel = 1`.

## Round 2 (post-#277, issue #261 continued)

The flag landed (#278, merged 2026-09-30) with CI serial + `--retry=1` + a
2-way `--shard` matrix; the server+node job's CI floor halved (4 m 36 s serial
single-job → 2 m 28 s for the longer shard). The remaining CI reds turned out
to be five distinct load-sensitive tests, each a real flake the sharding made
visible, fixed on that PR: `pane-repaint` ENOENT (missing capture-child log now
reads as zero bytes, the `paneReadsAsBooting` equation), the desktop action
runner's re-probe landing in the NEXT test's fake (the harness now retires the
query clients on `restore()`), `daemon.test.ts` peeking `firstFrames` off an
`opens` gate, and two remote-attach/repaint waits that gated on one async fact
and consumed a sibling. `apps/server/web` gained `--timeout 30000` (its act
chains measured 26 s on the throttled container); the two `NetworkPluginCard`
per-test 20 s ceilings came off to that package knob. CI reached full green
on the third desktop attempt - the reset-dialog test is a known intermittent
load flake (the fake's `node_settings` always returns a plane, so a reset's
re-fetch resurrects the Control Plane screen), tracked as its own follow-up.

Two suite splits followed, both the same mechanism (under `--parallel` a
single file is a single worker, so the longest file sets the package floor):
`subshell-ws-local-attach.test.ts` (26.1 s, 41 tests) into three files over a
shared harness (#279), and `tmux-runner.test.ts` (13.8 s, 49 tests) into
stub-argv / real-input / liveness files (#280), which took the pane-runtime
package from 13.9 s to 5.3 s at width 12. Both preserve every test verbatim
(reviewer-verified byte-identical bodies); both read the launcher recorder
through ESM live bindings + a `bumpCaptureCalls()` because import assignment
is illegal.

## Non-goals

`--no-isolate`, Playwright e2e, `test:cli`, cargo tests, turbo config
changes, CI runner upgrades.
