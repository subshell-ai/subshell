import { afterAll } from "bun:test";
import { readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "bun";

/**
 * Test preload: marks the process as a test run before any module that reads
 * the environment is imported.
 *
 * Registered via `bunfig.toml`'s `[test] preload`, so it applies to every
 * `bun test` invocation — `bun run test`, `turbo test`, and a bare `bun test`
 * typed by hand. That breadth is the point: the suites create and delete
 * users, subshells and paths, and must never do it in `./data/subshell.db`,
 * the developer's real database. Putting the override in the `test` script alone
 * would have left the bare invocation pointed at live data.
 *
 * Setting the flag is this file's first act; its second is registering the
 * temp-database cleanup below. `constants.ts` reads the flag and forces both
 * the database path and the subshell-log directory to disposable locations,
 * ignoring whatever the environment says. That split matters: this file
 * cannot decide the question by filling in variables that are unset, because
 * Bun loads `.env` before a preload runs — so `DATABASE_PATH` from a
 * developer's `.env` is already present here, and "set it only if absent"
 * silently hands the suites the live database.
 */
process.env.SUBSHELL_TEST_MODE = "1";

/**
 * Kills every tmux server this run started, as the net under each suite's own
 * reaper.
 *
 * A per-file `afterAll` is still the right thing to write — it releases the
 * pane when the file ends rather than when the run does, and it is visible to
 * whoever reads that file. This catches what no per-file reaper can: a launch
 * that throws before its socket is registered, a file with no reaper at all,
 * and a per-test timeout that ends a file before its hooks run. What leaks is
 * not a socket file but a live harness process — measured 2026-09-14, 17
 * `claude` panes at ~220 MB each were alive on one developer's machine, the
 * oldest a day old, one per full `bun test` since.
 *
 * SCOPED BY `TMUX_TMPDIR`, which the `test` script creates fresh per
 * invocation (`mktemp -d /tmp/subshell-test-tmux-XXXXXX`): tmux resolves
 * `-L <name>` under it, so "which servers did this run start" becomes a
 * directory listing rather than a guess, and a concurrent run's panes are
 * outside it. Two things make the variable's home the script and not this
 * file, both measured on bun 1.4.2:
 *
 * - **A child does not see a `process.env` written after startup.** Bun hands
 *   a spawned process the environment this one was STARTED with, so setting
 *   it here reaches `tmuxSocketPath()` in this process and NOT the tmux client
 *   — which would be worse than doing nothing: the socket would land in the
 *   default `/tmp`, while `cleanSocket` unlinked a path in the temp dir.
 * - **`/tmp`, not `tmpdir()`.** On macOS `tmpdir()` is a ~49-byte
 *   `/var/folders/...` path, and a unix socket path is capped at 104 bytes
 *   there (`assertSocketPathFits`) — `<tmpdir>/<this dir>/tmux-<uid>/subshell-<12hex>`
 *   lands within a few bytes of the limit, and tripping it fails every launch
 *   in the suite with tmux's bare "File name too long".
 *
 * A bare hand-typed `bun test` sets no such variable and gets no net; it also
 * gets the default socket dir, where killing anything would reach panes this
 * run never started. `kill-server`, not `kill-session`: the pane is the point.
 * Errors are ignored throughout — cleanup may never mask the run's results.
 */
afterAll(() => {
  const base = process.env.TMUX_TMPDIR;
  if (!base || !basename(base).startsWith("subshell-test-tmux-")) return;
  const socketDir = join(base, `tmux-${process.getuid?.() ?? 0}`);
  let sockets: string[] = [];
  try {
    sockets = readdirSync(socketDir);
  } catch {
    // no sockets were ever created — the common case
  }
  for (const socket of sockets) {
    spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  }
  rmSync(base, { recursive: true, force: true });
});

/**
 * Best-effort removal of this process's temp test databases once the run is
 * over — `constants.ts` creates `subshell-test-<pid>-<uuid>.db` (plus WAL
 * sidecars) under the OS temp dir.
 *
 * This must be the runner's own `afterAll` rather than a `process.on("exit")`
 * hook: `bun test` never fires exit/beforeExit listeners (verified
 * empirically on Bun 1.4.0), so an exit hook would leak a database file on
 * every single run. A preload-registered `afterAll` fires exactly once,
 * after every test file's own `afterAll` hooks — no suite loses its DB
 * mid-run — and it also fires on a failing run.
 *
 * The file is matched by this process's `subshell-test-<pid>-` prefix instead of
 * importing `TEST_DATABASE_PATH`: static imports hoist above the flag
 * assignment above, and `constants.ts` must not read the environment before
 * the flag is set. Errors are ignored — cleanup may never mask the results.
 */
afterAll(() => {
  const dir = tmpdir();
  const prefix = `subshell-test-${process.pid}-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no temp dir to clean
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !/\.db(-[a-z]+)?$/.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // best effort — temp files vanish on their own eventually
    }
  }
});
