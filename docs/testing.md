# Testing

Tests earn their cost by catching a plausible regression in behavior we own.
Correctness is the goal; coverage percentage and test count are not. For each
test, be able to name the future change that could introduce a bug and the
assertion that would catch it. Prefer a small regression test at the boundary
where that bug becomes observable. A new function or component doesn't
automatically need another test file.

## What to keep and what to remove

Prioritize failures that could cause unauthorized access, expose private data,
lose or corrupt user data, break a published protocol or artifact, leave a
process or resource in the wrong state, or report success after an operation
failed. Cover important flows at the boundary that can observe those failures:
permissions and privacy, persistence and migrations, wire compatibility,
release and installer behavior, process lifecycle, cleanup, and asynchronous
state changes. Use a browser or compiled CLI when that is where the regression
would surface. Test both the allowed action and its relevant refusal when each
can fail independently. This is a priority list, not a requirement to exercise
every branch or add a test file for every item.

Before adding a test, name the regression it would catch and check whether an
existing test already catches it. A useful test exercises production behavior
and would fail if that regression were reintroduced. It should also record the
expected behavior: make the relevant setup, action, and observable result clear
enough that a maintainer can tell what the system promises. Prefer assertions
about returned state, persisted data, requests, side effects, or a refusal over
assertions that execution merely completed. Extend the existing suite when
possible. A second layer needs a distinct failure mode to justify its setup and
maintenance cost; a second assertion of the same outcome doesn't add confidence
just because it runs through another component.

Remove tests that only assert fixed explanatory copy, CSS classes, wrapper
markup, trivial prop forwarding, TypeScript guarantees, or third-party
implementation details. Review routine copy as content, not as a product
regression suite. Keep a text assertion only when the output itself is a
behavioral contract: for example, a CLI or wire format another program reads,
a refusal or error that must preserve a machine-readable code, or a warning
whose mismatch could lead someone to take an unsafe or irreversible action.
When possible, assert the state, refusal, command, or action that makes the
output correct instead of freezing the whole sentence. Accessible names merit
assertions when they let someone find and operate a control.
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

When culling, identify the important regression and point to the remaining
test that would catch it. If no test catches a critical failure, keep or add the
smallest test that does. Remove obsolete absence checks and literal internal
defaults when they add no signal. Don't preserve redundant tests for a coverage
number, and don't hide the same workload in loops to lower the reported count.

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

A fourth presentation-focused pass removed seven more cases that only pinned
static explanatory sentences: setup and welcome copy, descriptions beneath
first-run choices, a QR dialog's fixed title/description, an empty plugin-list
message, an empty SSH peer-list message, and the maintenance card's fixed
“declared from this page” wording. The choice callbacks, QR address/path and
no-address behavior, maintenance state/action and refusal behavior, SSH trust
gates/fingerprints, and plugin control permissions remain covered. Runtime
state distinctions and actionable instructions in the node runtime card also
remain; those represent changing machine facts or commands a reader may need,
not merely editorial wording. This targeted pass has not established that every
remaining assertion in the repository is useful; future candidates should be
judged by the same behavior-versus-copy boundary above.

A fifth pass removed 15 more low-signal cases, bringing the targeted removal
count to 225. It removed prose-only assertions from plugin hints, install
labels/headings and the client setup-column description, the MCP connection
briefing, and an SEO file that only restated two literal route objects. It also
removed an empty-subtitle markup check from the assistant frame. The HTTP/API
auth boundary, install URLs and verified artifact selection, MCP tool
registration, disabled-control touch and keyboard behavior, and live server
settings behavior remain covered.

A sixth pass removed two more e2e cases: a login-form smoke already exercised
by the setup and signed-out authentication journeys, and an assertion that
only pinned the absence of a redundant address-summary sentence. It also
deleted the parked `09-mobile-navcrash.spec.ts` file, whose sole `test.fixme`
was documented as blocked before it could begin and whose crash was already
fixed. The targeted removal count is now 227. The audit remains in progress;
the current inventory has 1,082 TypeScript test files, and package-level
candidate screening is not a file-by-file disposition.

A seventh pass removed the two assertions in `detail-back-header.test.tsx` and
the file itself. They only checked that a boolean prop hid or showed a link in
a small wrapper; they didn't verify where the link navigates or any responsive
header behavior. It also removed two network-card cases that only pinned
explanatory sentences about a joined network. The joined/published state,
address, and publish/unpublish actions remain covered elsewhere in that suite.
An eighth pass removed five banner-layout/style assertions while retaining the
plain-output check that prevents ANSI escapes in service logs. It also removed
the test-environment self-check and duplicate non-placeholder case from the
production auth-secret guard suite; production placeholder rejection and real
secret acceptance remain. The targeted case removal count is now 238 and the
current TypeScript test-file inventory is 1,081. The audit remains in progress.

A ninth pass removed two tests of internal cache-reset hooks (`resetAuthForTests`
and `resetRequestlessContext`). They checked test isolation helpers rather
than application behavior. The memoized production getters and fresh-context
service boundaries remain tested. A tenth pass also removed the documentation
site's one-case SEO test, which only restated literal robots metadata. The
targeted removal count is now 241, with 1,080 TypeScript test files in the
current inventory.

An eleventh pass reviewed the client desktop UI test directory file by file
(31 files, including its shared app-flow suite). It removed four assistant
heading/copy cases from `node-assistant-state.test.ts`, retaining the non-empty
heading, update-screen identity and service-action behavior checks. It removed
two repeated version-order/unknown-version cases from `unenroll-gate.test.ts`;
the same semantic-version boundary behavior remains in `autostart-gate.test.ts`,
and the unenroll-specific threshold remains. It removed one redundant negative
assertion from `probe-facts.test.ts`, retaining the expected safe message for
an unreadable node configuration. This pass removed six test cases and several
duplicate assertions, for 248 targeted test-case removals total. A follow-up
auth review removed a duplicate system-key refusal assertion already exercised
across mounted admin routes, and duplicate inputs in the rate-limit math test;
it retained the real-admin/user-cookie boundary and cap checks. The other client UI files in this directory were
reviewed and retained because they exercise distinct flows or contracts such
as enrollment and recovery, service lifecycle and pane safety, settings
persistence, IPC authorization, Rust/TypeScript wire compatibility, or
production CSP behavior. This is one directory's disposition, not completion
of the repository-wide file review. The inventory now finds 1,080 TypeScript
test files and 11,678 direct test calls.

A twelfth pass reviewed the API credential and setup/enrollment slice:
`api-surface-auth.test.ts`, the bearer and cookie auth-guard suites,
`auth-rate-limit.test.ts`, `setup-route.test.ts`, `setup-progress.route.test.ts`,
`setup-agent-install.route.test.ts`, `setup-tmux-install.route.test.ts`, and
`nodes/enroll-route.test.ts`. These files were retained after review. Their
cases cover different security principals, first-run versus installed
authorization, installer refusal before streaming, caller-owned setup state,
single-use setup-key consumption, recovery transaction rollback and key
rotation, and encryption/signing key compatibility. The overlapping WebSocket
URL cases remain because one exercises the route under a configured base path
and the other checks helper normalization across schemes and path shapes. In
the auth guard and rate-limit files, a repeated system-key refusal and repeated
backoff inputs were removed because the mounted admin-route inventory and
neighboring boundary assertions already cover those outcomes. This pass added
no new test-case removals. The repository-wide review remains in progress.

A thirteenth pass reviewed backup-recovery credentials, emergency login,
WebSocket token minting, and the in-memory token store. It removed the
successful emergency-rewrite audit case because `auth-audit.test.ts` already
asserts the rewrite row and suppression of the ordinary sign-in row; the
negative audit check for a declined emergency attempt remains here. The token
store cap test now makes one refused mint and asserts its error type, status,
and message, instead of repeating the same refused mint for separate checks.
Recovery gating, scoped pane ownership, stale-session rejection, emergency
credential destruction, WebSocket token binding, single-use redemption,
capacity recovery, expiry cleanup, and disable-time revocation remain covered.
This pass removed one test case. The inventory now finds 1,080 TypeScript test
files and 11,678 direct test calls; the audit is still in progress.

A fourteenth pass completed the review of `downloads-route.test.ts` and
`downloads-shelf-serve.test.ts`; both were retained. The generated-installer
assertions are paired with shell execution cases for install branches,
stdin/TTY handling, checksum tools, failed downloads and file replacement.
The release-shelf tests exercise separate selection and failure cells for
operator-owned versus fetched bytes, protocol/version compatibility, source
availability, digest agreement and concurrent responses. These determine
which executable a node receives, so they protect correctness at the artifact
boundary. No cases were removed from these two files. The audit continues.

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
