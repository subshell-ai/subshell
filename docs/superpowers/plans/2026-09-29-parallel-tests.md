# Parallel Test Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or extra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun test` run files in parallel (issue #261): fix the hazards that break under `--parallel`, then set `parallel = N` in every package's `bunfig.toml`, then shard CI's longest test job.

**Architecture:** Bun's `bun test --parallel=N` runs each test file in a worker process with a **fresh module registry per file** (measured on 1.4.0 and 1.4.2; serial mode shares one cache across files). A preload-registered `afterAll` fires once per run serially but **once per file** under parallel (measured). Two existing test-infrastructure behaviors rely on the serial facts and must be fixed first: the `server/api` tmux sweep (kills sibling workers' panes) and 14 suites that reach SQLite tables without ever running migrations (they ride another file's boot).

**Tech Stack:** Bun 1.4.2 (upgraded from 1.4.0 during implementation; CI's builder image already had 1.4.2), Kysely + bun:sqlite, better-auth, turbo 2.x, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-parallel-tests-design.md`

## Global Constraints

- Never use `await import()` (`.claude/rules/code-style.md` "No Dynamic Imports").
- Package manager is Bun only; scripts run via `bun run` / `bunx`.
- No em dashes (U+2014) in authored prose or shipped strings; `bun run lint:prose` gates it.
- Comments in this repo carry the "why" and cite measurements; match the density of the files being edited.
- This machine's shell exports `SHELLOPTS=...onecmd:posix`, which makes bash-spawning tests run zero commands (known trap). ALWAYS run verification as `env -u SHELLOPTS bun ...` and suspect this artifact on any `bootstrap argv` / tmux-install style failure before believing it.
- `bun test` silently skips nonexistent paths: check the "Ran N tests across M files" line.
- No changeset: this changes no shipped code (test infra + CI only).
- Focused verification while iterating (`.claude/rules/verification.md`); the full trio at boundaries.

---

## PR 1: make the suites parallel-safe, then flip every package

### Task 1: `ensureMigratedTestDb()` helper, wired into the six implicit-boot files

Under `--parallel`, every file gets a fresh `@/db/index.js` singleton → a fresh per-file DB file (`subshell-test-<pid>-<uuid>.db` from `constants.ts`), and files that query without migrating fail with `no such table`. Fix each file's own dependency: run both migration runners (Kysely app tables + better-auth tables) in `beforeAll`. Idempotent by design (both runners track applied state in the DB itself), so serial runs are unaffected.

**Files:**
- Create: `apps/server/api/src/__tests__/helpers/test-database.ts`
- Modify: `apps/server/api/src/db/repositories/__tests__/channels.repository.test.ts`
- Modify: `apps/server/api/src/lib/__tests__/context.test.ts`
- Modify: `apps/server/api/src/services/__tests__/subshell-manager-mcp.test.ts` (beforeAll at ~:107)
- Modify: `apps/server/api/src/services/__tests__/subshell-manager-titling.test.ts` (beforeAll at ~:81)
- Modify: `apps/server/api/src/services/__tests__/subshell-manager.service.test.ts` (beforeAll at ~:100)
- Modify: `apps/server/api/src/auth/__tests__/provider-policy-service.test.ts` (beforeAll at ~:69, replace bare `runMigrations()`)

**Interfaces:**
- Produces: `export async function ensureMigratedTestDb(): Promise<void>` importable as `import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js"` (precedent: `@/__tests__/helpers/true-binary.js`).

- [ ] **Step 1: Write the failing repro**

Run from `apps/server/api/`:

```bash
env -u SHELLOPTS bun test src/db/repositories/__tests__/channels.repository.test.ts src/db/repositories/__tests__/identities.repository.test.ts --parallel=2 --timeout 30000
```

Expected: FAIL with `SQLiteError: no such table: channel_cursors` (already reproduced on 2026-09-29).

- [ ] **Step 2: Create the helper**

`apps/server/api/src/__tests__/helpers/test-database.ts`:

```ts
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { runMigrations } from "@/db/migrate.js";

/**
 * Ensures the test database carries both the app's tables and better-auth's,
 * via the same runners the server calls at boot. Both are idempotent (each
 * tracks applied state inside the database itself), so this is a full build
 * on a pristine file and a fast no-op afterwards.
 *
 * Every suite that touches `db` - directly or through a service - must call
 * this in `beforeAll`. Until issue #261 the rule was implicit: serial `bun
 * test` shares one module cache across files, so one early file's migrations
 * served every later file in the process. `--parallel` isolates each file
 * (fresh `db` singleton, fresh database file), and the implicit-boot suites
 * surfaced it as `no such table` - 14 suites, measured 2026-09-29.
 */
export async function ensureMigratedTestDb(): Promise<void> {
  await runMigrations();
  await runAuthMigrations();
}
```

- [ ] **Step 3: Wire the six files**

For `channels.repository.test.ts`: add `beforeAll` to the `bun:test` import, import the helper (step 2's import line), and add at top level after the imports:

```ts
beforeAll(ensureMigratedTestDb);
```

Same for `context.test.ts`.

For `subshell-manager-mcp.test.ts`, `subshell-manager-titling.test.ts`, `subshell-manager.service.test.ts`: import the helper and make the top line of each file's top-level `beforeAll(async () => { ... })` body:

```ts
  await ensureMigratedTestDb();
```

(Each of these suites also builds its own scratch database or stubs; the call fixes only the app-singleton `db` their service code reaches for the allowlist/token tables. Do not touch their private migrators.)

For `provider-policy-service.test.ts`: replace `await runMigrations();` with `await ensureMigratedTestDb();` inside its `beforeAll` (~:70), and drop the now-unused `runMigrations` import if nothing else in the file uses it.

- [ ] **Step 4: Run the repro and the six files**

```bash
env -u SHELLOPTS bun test src/db/repositories/__tests__/channels.repository.test.ts src/db/repositories/__tests__/identities.repository.test.ts --parallel=2 --timeout 30000
env -u SHELLOPTS bun test src/auth/__tests__/provider-policy-service.test.ts src/lib/__tests__/context.test.ts src/services/__tests__/subshell-manager-mcp.test.ts src/services/__tests__/subshell-manager-titling.test.ts src/services/__tests__/subshell-manager.service.test.ts --parallel=5 --timeout 30000
```

Expected: 0 fail. (The earlier 5-file load repro: `env -u SHELLOPTS bun test src/commands/__tests__/tmux-install.test.ts src/services/__tests__/subshell-manager-mcp.test.ts src/api/__tests__/files-route.test.ts src/api/__tests__/uploads-route.test.ts src/db/repositories/__tests__/prompts.repository.test.ts --parallel=5 --timeout 30000` must also be 0 fail.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/src/__tests__/helpers/test-database.ts apps/server/api/src/db/repositories/__tests__/channels.repository.test.ts apps/server/api/src/lib/__tests__/context.test.ts apps/server/api/src/services/__tests__/subshell-manager-mcp.test.ts apps/server/api/src/services/__tests__/subshell-manager-titling.test.ts apps/server/api/src/services/__tests__/subshell-manager.service.test.ts apps/server/api/src/auth/__tests__/provider-policy-service.test.ts
git commit -m "test(server): migrate the DB per file so parallel runs don't rely on file order"
```

### Task 2: move the tmux sweep from the preload to the test script

The preload's `afterAll` tmux net kills every server under the shared `TMUX_TMPDIR`. Serial it fires once at the end (safe); under `--parallel` it fires after EVERY file in every worker, killing sibling workers' live panes. The script that creates the temp dir already outlives all workers; it owns the kill.

**Files:**
- Create: `apps/server/api/scripts/test-run.sh`
- Modify: `apps/server/api/package.json` (`test` script)
- Modify: `apps/server/api/src/test-preload.ts` (remove the tmux `afterAll` block and its comment; rewrite surrounding comments)

**Interfaces:**
- Produces: `bun run test` / `turbo run test` for `@internal/server` keeps the same guarantees (throwaway tmux namespace per run, everything killed at exit) with no per-file side effects.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Create the script**

`apps/server/api/scripts/test-run.sh`:

```bash
#!/usr/bin/env bash
# The test runner @internal/server's `test` script wraps.
#
# Owns the run's throwaway tmux namespace: TMUX_TMPDIR is set for the whole
# `bun test` (children inherit the STARTUP env - a preload cannot re-home it
# later, measured on bun 1.4.2), so tmux resolves `-L <name>` under it and
# "which servers did this run start" is a directory listing. This file existed
# inside `src/test-preload.ts`'s afterAll until issue #261: under
# `bun test --parallel` a preload afterAll fires after EVERY file (measured
# 1.4.0), and a sweep scoped by directory would kill the panes of sibling
# workers still mid-suite. The script runs after every worker has exited,
# serial or parallel.
#
# The DB-file sweep stays in the preload: it is scoped by this process's PID
# prefix, so a per-file firing is exactly its right moment there.
set -u
dir="$(mktemp -d /tmp/subshell-test-tmux-XXXXXX)"
status=0
TMUX_TMPDIR="$dir" bun test --timeout 30000 src || status=$?
if command -v tmux >/dev/null 2>&1; then
  for sock in "$dir"/tmux-*/*; do
    [ -e "$sock" ] || continue
    tmux -L "${sock##*/}" kill-server 2>/dev/null
  done
fi
rm -rf "$dir"
exit "$status"
```

`chmod +x apps/server/api/scripts/test-run.sh`.

- [ ] **Step 2: Point the package script at it**

In `apps/server/api/package.json`, replace the `test` value

```
"test": "TMUX_TMPDIR=$(mktemp -d /tmp/subshell-test-tmux-XXXXXX) bun test --timeout 30000 src",
```

with

```
"test": "bash scripts/test-run.sh",
```

- [ ] **Step 3: Remove the tmux sweep from the preload**

In `apps/server/api/src/test-preload.ts`, delete the second doc comment (the "Kills every tmux server this run started" block) and its `afterAll`. Keep `process.env.SUBSHELL_TEST_MODE = "1"`, the tmux-related `spawnSync` import (now unused - drop it), and the DB-cleanup `afterAll` verbatim. Adjust the file header comment's one sentence that references the tmux net so it says the sweep now lives in `scripts/test-run.sh` and WHY (per-file firing under `--parallel`).

- [ ] **Step 4: Verify serial and parallel**

```bash
env -u SHELLOPTS bun run test 2>&1 | tail -3                  # serial today (bunfig has no parallel yet): green
env -u SHELLOPTS TMUX_TMPDIR=$(mktemp -d /tmp/subshell-test-tmux-XXXXXX) bun test --parallel=8 --timeout 30000 src 2>&1 | tail -3   # launch suites green under parallel
ls -d /tmp/subshell-test-tmux-* 2>/dev/null                    # after `bun run test`: nothing left behind
```

Expected: `0 fail` both times; temp dirs cleaned. (The middle command keeps the OLD sweep for now but no file kills another file's server here because the failing cluster is fixed - if a leftover dir appears from the manual run, kill it by hand.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/scripts/test-run.sh apps/server/api/package.json apps/server/api/src/test-preload.ts
git commit -m "test(server): move the tmux kill-all sweep to the run script (parallel-safe)"
```

### Task 3: flip `parallel` in every package's `test` script

> **Correction during execution (2026-09-29):** the plan originally put
> `parallel = N` in each package's `bunfig.toml` (so a bare `bun test` would
> get it too). Measured on bun 1.4.0 AND re-measured on 1.4.2: bun SILENTLY
> IGNORES a `parallel` key in bunfig's `[test]` - no PARALLEL banner, serial
> timings - and https://bun.com/docs/test documents `parallel` only as a CLI
> flag. The flag therefore lives in the `test` scripts (inside
> `apps/server/api/scripts/test-run.sh` for the server); a bare hand-typed
> `bun test` stays serial, which is the safe default. `--parallel` implies
> `--isolate` (fresh module registry per file), which Task 1's suites now
> assume.

**Files (the `test` entry of every package.json that runs `bun test`, plus `apps/server/api/scripts/test-run.sh`):**
- `--parallel=12`: `apps/server/api` (in `test-run.sh`), `apps/server/web`, `apps/node/agent`
- `--parallel=4`: the remaining 22 packages. For the two desktop apps the flag goes at the END of each half (`... src --parallel=4 && cd ui && bun test --parallel=4`) because `apps/server/desktop/ui/src/__tests__/tauri-config.test.ts` pins the exact `bun test --path-ignore-patterns "**/ui/**" src` string.

**Interfaces:**
- Consumes: Tasks 1-2 (server/api is only safe after both).
- Produces: `bun run test` wall time roughly: api ~12 s, web ~12 s, agent ~6 s, the rest sub-second each; CI jobs inherit it unchanged.

- [ ] **Step 1: Edit the three big packages**

Append to each existing file (keep its current comments; add one line above `parallel` per file):

```toml
# Files run in N worker processes (bun >= 1.2). N is measured, not core count:
# turbo runs packages concurrently, so core-count-per-package oversubscribes.
parallel = 12
```

- [ ] **Step 2: Create/extend the rest at `parallel = 4`**

For packages that already have a `[test]` section, add `parallel = 4` under it with a one-line comment. For a package with no bunfig, create:

```toml
# Issue #261: run this package's test files in parallel worker processes.
# 4: worker count is capped by file count anyway, and turbo runs packages
# alongside this one - CI runners have 4 cores.
[test]
parallel = 4
```

Skip any package whose `test` script does not invoke `bun test` (verify: `apps/docs` runs `bun test`, so it is included; `test:cli`/e2e/playwright are separate scripts and untouched).

- [ ] **Step 3: Verify per-package counts and result**

```bash
env -u SHELLOPTS bun run --cwd apps/server/api test 2>&1 | tail -3
env -u SHELLOPTS bun run --cwd apps/server/web test 2>&1 | tail -3
env -u SHELLOPTS bun run --cwd apps/node/agent test 2>&1 | tail -3
env -u SHELLOPTS bun run --cwd packages/pane-runtime test 2>&1 | tail -3
```

Expected: each `0 fail`, and the file counts match the serial baselines (270 / 260 / 48 / 28). Any package that flakes goes to `parallel = 1` with a comment naming the flake and rejoins after a fix (spec's flake policy).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: run every package's bun test in parallel workers (issue #261)"
```

### Task 4: bake - three full suites and one serial gate

**Files:** none (verification task); touch only if the bake forces `parallel = 1` reversions.

- [ ] **Step 1: Full parallel suite, three consecutive runs**

```bash
for i in 1 2 3; do env -u SHELLOPTS bun run test 2>&1 | tail -1 || echo "RUN $i FAILED"; done
```

Expected: three `... Failed: N`-free lines (turbo prints `Failed:` per failing task; expect zero across all packages). A failure here is a finding: reproduce the package alone under `--parallel`, fix at the root (Task 1 pattern or file-local leak of `process.env` across files sharing a worker), re-bake. Do not paper over with retries.

- [ ] **Step 2: Serial gate - the sweep move must not have broken serial semantics**

```bash
env -u SHELLOPTS bunx turbo run test --continue --filter=@internal/server -- --parallel=1
env -u SHELLOPTS bun run test:scripts
```

Expected: green. (`--parallel=1` on the task command proves the script/preload pair still works one-file-at-a-time.)

- [ ] **Step 3: Full static verification boundary**

```bash
env -u SHELLOPTS bun run verify-types && bun run lint:check && bun run lint:prose
```

Expected: all three clean (the preload edit touched typed files).

- [ ] **Step 4: Update the docs that describe the old behavior**

- `.claude/rules/testing.md`: add 2-3 lines under "Commands": every package's `bunfig.toml` sets `parallel`; files get a fresh module registry per file (no cross-file boot); suites must migrate their DB via `@/__tests__/helpers/test-database.js`.
- Check `AGENTS.md` files and `docs/` for claims of serial test behavior (`grep -rn "serial" AGENTS.md apps/server/api/AGENTS.md docs -i | grep -i test`) and correct any that the parallel flip invalidates.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A && git commit -m "docs(test): record parallel run semantics in the testing rules"
git push -u origin feat/parallel-tests
gh pr create --title "Run bun test files in parallel (fixes #261)" --body "Moves the tmux sweep to the run script, makes every DB-touching server suite migrate its own DB in beforeAll (parallel isolates each file - the old per-process boot sharing is gone), then sets parallel in every package's bunfig.toml. Baselines, measurements and the design: docs/superpowers/specs/2026-09-29-parallel-tests-design.md. No changeset: test infra only, no shipped code changes."
```

Watch CI to green (`gh run watch`; per memory, `gh pr merge --auto` merges immediately here - merge by hand after green).

---

## PR 2: CI shard + committed timings

### Task 5: split `test-server-node` into two `--shard` jobs

Bun's `--shard=a/b` runs one subset of files; `--timings` (committed JSON) lets it balance subsets by measured per-file duration and start the slowest first. Turbo's `--` passthrough appends args to each filtered task, so both shards' halves run per package, and the two halves of all three packages land across the two jobs.

**Files:**
- Modify: `.github/workflows/test.yml` (the `test-server-node` job, ~:387-467)
- Create: `.bun-test-timings.json` (repo root, committed)
- Create: `scripts/test-timings.sh` + root `package.json` `test:timings` script

**Interfaces:**
- Consumes: PR 1 (parallel flag lands first; sharding without it would still serialize each half).
- Produces: `test-server-node` job runs as two matrix legs, each ~half the wall time.

- [ ] **Step 1: Generate the timings file**

```bash
bash scripts/test-timings.sh
```

where `scripts/test-timings.sh` (create, chmod +x) runs the three sharded packages sequentially so no two processes write the JSON at once:

```bash
#!/usr/bin/env bash
# Regenerates the committed .bun-test-timings.json that CI's --shard balancing
# reads (bun merges durations from every --timings file it is given; only the
# first receives writes, so this runs package by package).
#
# After big test waves, or when a CI shard leg starts finishing much later
# than its sibling. Takes minutes; the full suite, three packages, run
# serially on purpose so the shared file is never written concurrently.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tfile="$root/.bun-test-timings.json"
cd "$root/apps/server/api" && ./scripts/test-run.sh && \
  bun test --timeout 30000 src --timings="$tfile" --update-timings
cd "$root/apps/node/agent" && bun test --timings="$tfile" --update-timings
cd "$root/apps/node/web" && bun test --pass-with-no-tests --timings="$tfile" --update-timings
echo "wrote $tfile"
```

(Running api's tests once for warm-up then measuring is unnecessary; the `--update-timings` pass alone is fine - drop the first `./scripts/test-run.sh &&` if it adds no signal. Expected: a JSON file mapping test-file paths to durations, committed.)

- [ ] **Step 2: Add the root script**

In root `package.json` scripts, beside `"test"`:

```json
"test:timings": "bash scripts/test-timings.sh",
```

- [ ] **Step 3: Matrix the CI job**

In `.github/workflows/test.yml`, change `test-server-node` to:

```yaml
  test-server-node:
    name: "Test: server + node (shard ${{ matrix.shard }})"
    needs: plan
    if: needs.plan.outputs.server-node == 'true'
    strategy:
      fail-fast: false
      matrix:
        shard: ["1/2", "2/2"]
    runs-on: ubuntu-24.04
```

(everything else in the job unchanged) and the test step to:

```yaml
      - name: Run server and node tests
        run: bunx turbo run test --continue --filter=@internal/server --filter=@internal/node -- --shard=${{ matrix.shard }} --timings="$GITHUB_WORKSPACE/.bun-test-timings.json"
```

Verify `plan.outputs.server-node` gating and the `Un-root the workspace` step are untouched (they run per leg; chown is idempotent).

- [ ] **Step 4: Prove the wiring locally**

```bash
env -u SHELLOPTS bunx turbo run test --continue --filter=@internal/node -- --shard=1/2 --timings="$PWD/.bun-test-timings.json"
env -u SHELLOPTS bunx turbo run test --continue --filter=@internal/node -- --shard=2/2 --timings="$PWD/.bun-test-timings.json"
```

Expected: both green, together covering all of `@internal/node`'s files (sum the "across N files" lines = the package's full count).

- [ ] **Step 5: PR, merge, measure**

```bash
git add .github/workflows/test.yml .bun-test-timings.json scripts/test-timings.sh package.json
git commit -m "ci: shard the server+node test job across two runners (issue #261)"
git push && gh pr create --title "Shard test-server-node across two runners" --body "Two --shard legs with committed --timings durations so bun balances files by measured time. Follow-up to PR 1 per the parallel-tests spec."
```

After merge, record the before/after job duration in the PR (comment). If a leg is still a long pole relative to other jobs, that is a new decision, not this PR's problem.

---

## Self-review notes (author, 2026-09-29)

- Spec coverage: hazard 1 (sweep) = Task 2; hazard 2 (implicit migrations) = Task 1; ordering-shuffle control = Task 4 bake + flake policy; mechanism = Task 3; CI = Task 5. The `bootstrap argv` failure the spec's section-3 predicted turned out to be the local `SHELLOPTS` artifact (reproduced serially, passes under `env -u SHELLOPTS`) - no task needed; the Global Constraints now name the trap.
- The 14-failing-suite list came from one `--parallel=8` run of `apps/server/api` on 2026-09-29; the bake is the net for any suite this list missed.

## Execution record (2026-09-29/30)

- Task 1 shipped 5 files (not 6): `subshell-manager.service.test.ts` already migrated its DB; its two parallel failures were hazard-1 collateral (sweep-killed live panes), fixed by Task 2. The MCP suite additionally needs `prepareLocalPlugins()` (the auto-restart gate silently defers on a pluginless instance).
- Task 3 shipped as script flags, not bunfig (see the correction note there); `apps/server/desktop`'s tauri-config meta-test pins the script string, so the flag goes at each half's END (commit 1d2b9192).
- CI's first PR1 run (4-core runner, N=12) caught what 48 cores could not: three `Test: web` wall-clock timeouts and a one-unlink-then-peek race in `daemon.test.ts`. Fixed by `SUBSHELL_TEST_PARALLEL` (CI pins 4, commit abcc2089) and waiting for both settle unlinks (099a23d3). No package needed the `parallel = 1` fallback.
