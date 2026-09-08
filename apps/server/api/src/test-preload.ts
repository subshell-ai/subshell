import { afterAll } from "bun:test";
import { readdirSync, unlinkSync } from "node:fs";
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
