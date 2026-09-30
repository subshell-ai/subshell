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

Per-package `bunfig.toml` carries `parallel = N`. Bun spawns N workers,
distributes files, and isolates each file's module registry
(`--isolate`, implied). Worker count is capped by file count, so small
packages self-limit. Proposed N: **12** for `server/api`, `server/web`,
`node/agent`; **4** elsewhere. Tunable after first green.

`bunfig.toml` (not a script flag) because the flag must reach every
invocation — `bun run test`, `turbo test`, and a bare hand-typed
`bun test` — the same rationale each package's `preload` already lives
there for.

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

2. **Implicit migration ordering** (`server/api`): 14 files query tables
   without running migrations, surviving serially because files that run
   earlier migrated the process-wide shared DB. Fresh per-file DBs under
   parallel expose it as `no such table` (56 failures). Fix: an explicit
   `ensureTestDatabase()` helper (Kysely + better-auth migrations) called
   in each DB-touching suite's `beforeAll`. Idempotent, so serial stays
   green.

3. **A subprocess/port test** (`bootstrap argv`): triage individually in
   the same PR (reproducer-first).

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
  the chosen N, plus one serial run (`--parallel=1`) to prove the sweep
  move didn't break serial semantics.
- Flake policy: any package that fails the bake gets its `N` set back to
  `1` and rejoins later.

## Non-goals

`--no-isolate`, Playwright e2e, `test:cli`, cargo tests, turbo config
changes, CI runner upgrades.
