# Testing

Tests earn their cost by catching a plausible failure in behavior we own.
Prefer a small regression test at the boundary that can observe the failure.
A new function or component doesn't automatically need a new test file.

## What to keep and what to remove

Keep coverage for permissions and privacy, data loss, migrations, wire
compatibility, process lifecycle, cleanup, and asynchronous state transitions.
Keep browser tests for behavior that depends on real browser layout, input, or
networking, and compiled CLI tests for behavior source imports can't establish.
Test both the allowed action and the relevant refusal when a boundary needs it.

Before adding a test, name the regression it would catch and check whether an
existing test already catches it. Extend that suite when possible. A second
layer needs a different failure to justify its setup and maintenance cost.

Remove tests that only assert fixed copy, CSS classes, wrapper markup, trivial
prop forwarding, TypeScript guarantees, or third-party implementation details.
Don't test a copy of production logic or a helper that exists only in the test.
Don't turn every input combination into another test when it exercises the
same branch. Keep meaningful boundaries, accessibility, and input validation.
Happy DOM class assertions don't prove clipping, contrast, or responsive layout;
review those in a real browser instead.

Compare what tests execute, not just their names. The same cases against two
independent implementations still protect two places that can break. Conversely,
a test-local copy of an algorithm proves nothing about the production function;
exercise the real function or remove the redundant experiment. Runtime parsing
tests still matter for untrusted inputs even when TypeScript rejects their shape.

When culling, name the check that retains the important behavior. Remove obsolete
UI-absence checks and literal internal-default assertions when they add no signal;
retain wire compatibility, permission boundaries, and anti-vacuity guards. Don't
hide the same workload in loops merely to lower the reported test count.

Reuse shared boundary tests where they execute the same production path. For
example, `api-surface-auth.test.ts` checks every mounted guarded API route with
anonymous and node credentials, so a per-resource test that only repeats its
401 result adds no distinct coverage. Keep multipart requests, conditional
authentication, permission scopes, ownership, and tests that verify refused
writes leave state unchanged where they exercise something the shared check doesn't.

When a render-only test repeats the setup of an interaction test, preserve any
useful accessible-state assertion on that interaction instead of mounting again.
For polling, control the scheduler and await actual query promises; don't sleep
through production intervals. Successful fakes must provide the response the
operation awaits. Real deadline tests still matter for cancellation and process
termination.

## Choose a verification scope

| Change | During iteration | Before handoff or in PR CI |
| --- | --- | --- |
| Internal prose | Prose check | Prose check; no product suites |
| Copy or styling without behavior changes | Content/visual review and relevant lint | The same focused checks; CI conservatively selects the owning package |
| Documentation site | Content tests and changed-page review | Docs build, types, content/export checks |
| Unit test or test setup | Changed files from the package directory | Owning package's suite |
| App behavior | Existing covering files | App suite and affected consumers; integration where applicable |
| Shared package | Package suite | Transitive consumer builds and tests |
| Rust app | Selected crate | That app on Linux and macOS |
| Shared Rust/native helper | Focused native checks | Core and both desktop apps on Linux and macOS |
| Toolchain, CI selection, or unknown input | Planner/workflow checks | Full verification |
| Release | Explicit full verification | Fresh full verification on the release revision before publication |

Use the package `test` script for a suite run, so it gets its worker settings
and cleanup. A single `bun test ./path/to/file.test.ts` from that package is
fine during editing. Check the reported file count: a typo can select nothing.
Automation shells must clear `SHELLOPTS` and `BASHOPTS`. Capture output once and
inspect that file after a failure; rerun after a fix, not just to recover a name
lost behind `tail`.

```bash
bun run test:changed -- --plan
bun run test:changed -- --base origin/main
bun run test:changed -- --unit
bun run verify:changed
bun run test:full
```

The local planner includes the branch diff from the base's merge point, staged
and unstaged edits, and untracked files. Both sides of a rename count. Missing
history or an unknown input selects everything and reports the reason. Fetch a
missing base rather than narrowing a fallback by hand. A successful relevant
check doesn't need repeating at every commit, push, PR, or handoff.

`test:changed` runs the selected unit, integration, and Rust tiers; `--unit`
is the iteration shortcut. `verify:changed` also builds and type-checks affected
packages, runs their lint, and checks repository contracts. `test:full` includes
all of those plus the live dependency audit. `bun run test` remains workspace
unit tests only. Pre-push runs affected types/lint and fast repository checks,
without duplicating CI's test runs.

## How CI selects work

`scripts/ci-test-plan.ts` discovers workspace manifests and follows local
production, development, peer, and optional dependency edges. It selects the
changed workspace and its transitive consumers. Tests, fixtures under test
folders, and preloads affect only their owning suite. Rust source follows the
Cargo path dependencies separately; ordinary desktop React edits don't start
Rust builds. Rust changes also select the owning desktop's JS contract tests
for IPC, wire names, and signing configuration; shared core changes select both.
Global toolchain or verification changes run every tier.

This is package selection, not a claim that static imports describe every test
input. Browser fixtures/configuration changes run the whole browser suite;
a change only to browser specs runs those specs with account setup. Product
changes reaching the browser stack run the complete browser suite because the
specs share state and production paths cross feature boundaries. Script tests
have explicit repository-input rules for manifests, publishing, installers, and
shared release helpers. Keep those rules current when a test begins reading an
external file. An unknown root input or deleted workspace selects everything.

PR CI has one planner, one static-check job, up to three unit jobs, one selected
integration job, and selected Linux/macOS native jobs. `Tests passed` aggregates
those results and rejects a required job that failed, was skipped, or was
cancelled. Only selected consumers and their dependencies build; planning needs
neither a dependency install nor Turbo. All existing workspace test scripts are
discovered automatically, including docs and node-web. The e2e workspace
explicitly depends on the real node daemon its fixtures launch, so a node-only
production change also selects browser coverage. Brand tests and e2e
capture-helper tests now have ordinary workspace `test` scripts too.

Full release verification bypasses change selection. `release.yml`, `docs.yml`, and `website.yml` call the
same workflow with `full: true` before their tag-writing plans; npm
publication uses that gate too. Unit and browser tests run without retries. A failed release gate
requires fixing the failure before publishing; it cannot borrow a green result
from another revision. Local full verification covers the current host, while
CI covers both Linux and macOS. Published-artifact smoke checks still run on the
release shards, and the existing post-cut download check remains separate.

## Audit and runner assessment, 2026-10-25

The initial inventory found more than 1,000 TypeScript test files and more than
12,000 statically declared cases. This is an inventory count, not a runner count:
parameterized cases and platform skips change the latter. The review covered the
runner/configuration, suite distribution, source-reading tests, and presentation
and helper duplicates. It did not attempt to declare every remaining case valuable.

The first pass removed 62 cases across 12 files: CSS/layout assertions in sidebar
cells, headers, segmented controls, the assistant frame/rail and dropdowns;
redundant tint determinism checks; and tests of a test-only icon filter plus a
hardcoded plugin count; and repeated bundle-length and sourcemap assertions
for each built-in. The plugin manifest, entry-presence, and import-portability
checks remain. API-version validation no longer pins the number of plugins. Navigation,
permissions, notification ownership, accessible state, drag/drop mutations,
failure recovery, and generated-route/security checks remain. No product code
was removed in that pass. It was a narrow cull, not a complete value audit.

The follow-up inventory covered 1,085 TypeScript test/spec files. A second review
removed another 83 cases, bringing the total removed to 145. It examined duplicate
bodies, source-reading checks, literal/constructor assertions, presentation checks,
and overlapping suites across the API, web, desktop, mobile, site, and shared
packages. Inventory and candidate screening do not establish that every remaining
test is valuable. Examples of the decisions made:

| Removed or replaced | Coverage retained |
| --- | --- |
| Kysely's generic CRUD, returning, and transaction demonstrations | Real repository/route persistence and atomicity tests; a focused `openSqliteDatabase` foreign-key enforcement check |
| Context constructor shape assertions | Requestless-context identity/reset checks and real HTTP/MCP service execution |
| Repeated launch-directory scenarios | Recent-path precedence, delayed-node answers, machine switches, and caller-provided directories |
| Fixed icons, copy, spacing, old control names, and repeated no-Re-check cases | Navigation, callbacks, accessibility, gating, and mutation tests; content/layout review |
| Internal timing/type assertions and duplicate legal constants | Timeout/idle behavior, wire-version compatibility, license notices, and `lint:licenses` |
| Several source-string assertions about desktop wiring | Existing host interaction tests for setup firing, requested screens, and handoff |
| Replay tests using a locally rebuilt "correct" frame | The real server serializer feeding real xterm; both retained tests fail when the trailing-newline regression is reintroduced in a temporary copy |

The mobile and web mouse-report suites and the two desktop release suites remain:
they exercise separate production implementations. The largest suites include
runtime frame validation, service lifecycle, CLI dispatch, and node connection
handling; their case counts alone don't establish redundancy. Native signing/IPC
checks, migrations, cleanup/races, and published-artifact integration checks also
remain. Further culls should use the same evidence standard, not a quota or a
blanket claim that a particular layer is redundant.

A third pass removed 58 more cases, bringing the total to 203. Of these, 24
only repeated anonymous rejection already exercised by the composed API route
suite. Multipart rejection, conditional setup authentication, scoped permissions,
ownership, and refused writes leaving data intact remain in their resource suites.
A temporary mutation removing the meta route's guard failed the retained route
inventory, confirming that deleting its duplicate 401 case didn't lose that guard.

The other removals include identical handoff, launch-body, launch-node, and update
state cases; duplicate protocol constants now pinned only in the canonical frame
suite; internal timing/cap literals; fixed SVG/layout/copy checks; redundant grid
properties; and random backoff sampling already covered by deterministic bounds.
Preset toggles now check their accessible state and refetch ordering in the same
interaction, avoiding four extra mounts without losing those assertions.

Two slow tests kept their behavior and lost unnecessary waits:

| Test | Previous full-run duration | After the change, full run |
| --- | ---: | ---: |
| Shared subagent polling | 15,620 ms | 19 ms |
| MCP prompt delivery success | 10,033 ms | 26 ms |

The polling test drives the real interval callbacks and awaits real query promises.
Four temporary mutations verified that it catches hidden-tab polling, duplicate
fetches, interval leaks, and disabled observers keeping a timer alive. The prompt
fake now echoes the submitted input, so the success test no longer waits for the
ten-second fallback; the shared delivery suite retains timeout coverage. These
are individual test durations, not an equivalent reduction in parallel suite wall
time: the complete workspace run took 44.07 seconds, versus 46.29 previously.

The larger measured cost was orchestration. In
[PR run 40253886630](https://github.com/subshell-ai/subshell/actions/runs/40253886630),
planning took 71 seconds including installation. Mobile tests took less than a
second after a 47-second full-repo build. Script tests took about two seconds
after a 56-second build, and the job also ran unrelated website tests. The old
router sent every app/package edit to scripts and treated existing docs/node-web
workspaces as unknown, selecting every job. The old verification instructions
also demanded a full suite at every task boundary. Those costs are addressed by
selection and shared guidance; hosted wall-time savings need measurement after
this workflow runs in CI.

Keep Bun. Both runners already have parallel file workers, isolation, sharding,
and worker controls: [Bun's execution options](https://bun.sh/docs/test/parallel)
and [Vitest's performance guidance](https://vitest.dev/guide/improving-performance).
Vitest additionally offers Vite-aware related/changed selection and browser
mode, but its normal [worker pools](https://vitest.dev/config/pool) use Node.
Our server uses `bun:sqlite`, and many suites use `Bun.serve` and `Bun.spawn`.
A migration would require retaining Bun for those suites or replacing runtime
behavior in the tests. That isn't justified by a parallelism feature we already
have. Static import selection also needs explicit rules for files read at runtime.

A local comparison used Bun 1.4.4 and Vitest 5.0.5 under Node 26.8.1 on the same
six existing pure-logic suites (105 cases): ANSI stripping, directory allowlists,
shared geometry, lingering, release paths, and versions. The Vitest copies only
changed test imports and source paths. Three complete process launches per mode,
including startup, produced these median wall times:

| Runner | Median |
| --- | ---: |
| Bun serial | 0.070 s |
| Bun, four isolated workers | 0.131 s |
| Bun, four reused workers | 0.128 s |
| Vitest, four forks | 0.334 s |
| Vitest, four threads | 0.311 s |

The retained web suite also passed all 3,102 cases in each of three Bun modes.
Single local runs took 96.85 s serially, 32.52 s with four isolated workers, and
16.77 s with twelve. That supports keeping the existing local web width of
twelve; it doesn't establish a safe width on hosted runners.

This small sample measures startup and pure logic, not the backend database or
Happy DOM suites, and uses a newer Node than CI's pinned Node 24. It supports no
claim about a whole-repo migration speedup. It does show that adding workers to
very short suites can cost more than it saves. Don't raise worker counts by
instinct, enable in-file concurrency on shared DB/DOM state, or disable isolation
without measuring the representative suite. Keep the existing local package
widths and CI's measured serial regime until hosted measurements justify a change.

After the third cull, workspace unit verification on Bun 1.4.4 reports 12,251
passed, two skipped, and none failed across 1,000 files. All 60 Turbo tasks
succeeded in 44.07 seconds locally, with 20 unchanged tasks served from cache.
The preceding run reported 12,309 passes; the difference confirms the additional
58 removals. Repository-script tests passed 335 cases, with three macOS-only skips.
Workflow validation, shell lint, the new drivers' type checks, and the changed
packages' types/lint also passed. These are local results; the hosted browser,
compiled CLI, and Linux/macOS native tiers still need their first run of the new
workflow before any release can pass its gate.
