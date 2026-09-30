# Testing internals: why the tmux reaper, the per-file database, the 30 s timeout and turbo dependsOn are shaped this way. Moved verbatim from AGENTS.md ("Testing"); AGENTS.md keeps the rules and routes here.

**A run reaps its own tmux servers, and that net lives in the script that
wraps the `test` command (`scripts/test-run.sh`), not the preload.** The
script mktemps the run's `TMUX_TMPDIR=/tmp/subshell-test-tmux-XXXXXX`
namespace, runs `bun test` with it, and after `bun test` exits
`kill-server`s every socket under it and removes the directory; tmux
resolves `-L <name>` under the variable, so "what this run started" is a
directory listing, and a concurrent run's panes are outside it. Until
issue #261 the sweep itself sat in the preload's `afterAll`. That moved
because of a second measured fact (bun 1.4.0): a preload `afterAll` fires
once per run serially, but after EVERY file under `--parallel`. A
directory-scoped sweep there would kill the panes of sibling workers still
mid-suite. The script outlives every worker, so it owns the kill. What
leaks without the net is not a socket file but a live harness: measured
2026-09-14, 17 real `claude` panes at ~220 MB each were alive on a
developer's machine, the oldest a day old, one per full `bun test` since,
from `subshells-local-launch-off.test.ts`, which asserted `not 403 / not
404` on a create and got a 409 on CI (no claude) and a genuine 200 on a dev
box. That suite now pins `CLAUDE_PATH` at a path that does not exist, which
is the real fix; the net is under it, for the leak classes a per-file
`afterAll` cannot catch (a launch that throws before its socket is
registered, a file with no reaper, a timeout that ends a file before its
hooks).

Two measured facts fix WHERE the variable is set. A child does not see a
`process.env` written after startup (bun 1.4.2): Bun hands a spawned process
the environment this one was STARTED with, so setting it in the preload
reaches `tmuxSocketPath()` in-process and not the tmux client; the socket
would land in `/tmp` while `cleanSocket` unlinked a path in the temp dir,
which is worse than no net. The script sets it before `bun test` starts, so
every worker and every child inherits it. And `/tmp` rather than `$TMPDIR`:
on macOS the latter is a ~49-byte `/var/folders/...` path against a 104-byte
socket-path cap, so the derived socket lands within a few bytes of tmux's
bare "File name too long". A bare hand-typed `bun test` sets no such
variable and gets no net, correctly, since it also gets the shared default
socket dir, where killing anything would reach panes this run never started.

**The net covers this package only.** `packages/pane-runtime` and
`apps/node/agent` also spawn real tmux and run a bare `bun test`, so nothing
sweeps behind them; what stands there is each suite's own `afterAll`, which
registers a socket BEFORE spawning on it (`freshSocket` in
`tmux-runner.test.ts`) and so has no window to leak through. That is a
narrower guarantee than this one (it holds as long as every future suite
keeps registering first), and it is stated here rather than fixed because
extending the variable to those packages is a change to how their sockets are
named, not a line of cleanup.

**The `--timeout 30000` in the `test` script is measured, not caution.**
This package's suites set up against that temp DB through migrations and
better-auth table creation (each file's own DB under `--parallel`), and
bun's 5000 ms per-test/hook default blew
three times in three CI runs, each time in a different file, which is the
signature of load, not of a bug: the auth-registration `beforeAll` at
8830 ms (run 34581907693), the heaviest `default-profiles` case (suite since
removed; the seeding went with spec 2026-09-13) at 5508 ms with siblings at
242-298 ms (run 34583881882), the `passkey-plugin`
`beforeAll` at 5428 ms (run 34584698469). Every one PASSED on an idle
machine and failed with "timed out", never an assertion. Per-file budgets
were tried first and abandoned as whack-a-mole: the unit that is actually
slow is this package's setup, so the fix is the package's script. A
genuinely hung test still fails, at 30 s, with a named duration, rather
than at a number chosen by the runner's defaults.

**`test` must keep turbo's `dependsOn: ["^build"]`**; do not narrow it for a
faster loop. This package once overrode it to
`["@internal/backend-errors#build:dev"]`, which let `@internal/server#test` run
CONCURRENTLY with a dependency's build. `tsdown` cleans `outDir` before writing,
so `packages/subshell-protocol/dist` vanishes for a moment mid-run, and
`__tests__/cli-entry.test.ts` spawns a REAL subprocess (`bun src/index.ts`),
which is the one place that re-resolves the workspace package from disk rather
than from the parent's module cache. The child died with `Cannot find module
'@internal/subshell-protocol'`, surfacing as a rare "configure must not boot"
failure that passed in isolation and on every re-run. `@internal/server#build`
failed the same way, less often. The override is gone; the root config is
correct and this package now inherits it.

## The testing history this replaced (moved from AGENTS.md "Testing")

Serial `bun test` (one process, shared module cache) gives every file the
same DB, so a suite may never assume it starts empty; under the `test`
script's `--parallel=12` the opposite holds, every file gets a fresh module
registry and its own DB file, so a suite may never assume another file's
migrations happened either - DB-touching suites call
`@/__tests__/helpers/test-database.js` explicitly. Tests never touch
`data/`. (The path used to be the URI string `file::memory:?cache=shared`, but
Bun treats URI strings as file names; every suite was sharing one literal
CWD file.)
