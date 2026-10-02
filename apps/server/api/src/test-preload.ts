import { afterAll } from "bun:test";
import { readdirSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Setting the flag is this file's first act; it then canonicalizes the test
 * temp root and registers the database cleanup below. `constants.ts` reads the flag and forces both
 * the database path and the subshell-log directory to disposable locations,
 * ignoring whatever the environment says. That split matters: this file
 * cannot decide the question by filling in variables that are unset, because
 * Bun loads `.env` before a preload runs — so `DATABASE_PATH` from a
 * developer's `.env` is already present here, and "set it only if absent"
 * silently hands the suites the live database.
 *
 * The tmux kill-all sweep that lived in this file until issue #261 is now in
 * `scripts/test-run.sh`, which wraps the `test` script. Here it was a
 * preload-registered `afterAll`, which fires once per run serially but after
 * EVERY file under `--parallel` (measured on 1.4.0) — and a sweep scoped by
 * the run's shared `TMUX_TMPDIR` would then kill the panes of sibling workers
 * still mid-suite. The script outlives every worker, so it can sweep the same
 * namespace safely.
 */
process.env.SUBSHELL_TEST_MODE = "1";

// Constants and subprocess fixtures generate explicit DB/data/config paths beneath os.tmpdir().
// Keep those test-owned roots canonical on macOS, where the standard /var ancestor is an alias.
process.env[process.platform === "win32" ? "TEMP" : "TMPDIR"] = realpathSync(tmpdir());

/**
 * Best-effort removal of this process's temp test databases once the run is
 * over — `constants.ts` creates `subshell-test-<pid>-<uuid>.db` (plus WAL
 * sidecars) under the OS temp dir.
 *
 * This must be the runner's own `afterAll` rather than a `process.on("exit")`
 * hook: `bun test` never fires exit/beforeExit listeners (verified
 * empirically on Bun 1.4.0), so an exit hook would leak a database file on
 * every single run. A preload-registered `afterAll` fires after every test
 * file's own `afterAll` hooks and on failing runs — once per run serially,
 * once per file under `--parallel`. The PID prefix makes that safe in both
 * modes: a firing removes only this process's files, files run one at a time
 * inside a worker, and a later file's DB is created when it imports
 * `constants.ts` — after the earlier sweep. (The tmux sweep could not say the
 * same; see the header.)
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
