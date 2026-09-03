import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATABASE_PATH, IS_TEST, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";

/** Absolute path to the module under test, for the out-of-process probes below. */
const CONSTANTS_MODULE = join(dirname(import.meta.dir), "constants.ts");

interface ProbeResult {
  IS_TEST: boolean;
  DATABASE_PATH: string;
  SUBSHELL_SERVER_DATA_DIR: string;
  /** The probe process's cwd — what any relative path would resolve against. */
  cwd: string;
}

/**
 * Imports `constants.ts` in a fresh process under a given environment and
 * returns what it resolved.
 *
 * Out-of-process because the module reads the environment once, at import:
 * this suite has already imported it, so the only way to see it resolve a
 * *different* environment is a new process. The probe runs from a temp
 * directory so no `.env` file is discovered — every variable that matters is
 * passed explicitly.
 */
function probeConstants(env: Record<string, string | undefined>): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "subshell-constants-probe-"));
  const script = join(dir, "probe.ts");
  writeFileSync(
    script,
    `import { DATABASE_PATH, IS_TEST, SUBSHELL_SERVER_DATA_DIR } from ${JSON.stringify(CONSTANTS_MODULE)};\n` +
      `console.log(JSON.stringify({ IS_TEST, DATABASE_PATH, SUBSHELL_SERVER_DATA_DIR, cwd: process.cwd() }));\n`,
  );

  const proc = Bun.spawnSync(["bun", "run", script], {
    cwd: dir,
    // A bare object, not a spread of process.env: the parent is itself a test
    // run (NODE_ENV=test, SUBSHELL_TEST_MODE=1), and inheriting either would make
    // every probe look like test mode regardless of what it was asked.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // TMPDIR travels so the probe's `os.tmpdir()` matches this process's —
      // without it macOS falls back to /tmp and the temp-dir assertions below
      // compare two different roots.
      TMPDIR: process.env.TMPDIR,
      ...env,
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    throw new Error(`probe failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return JSON.parse(stdout.split("\n").at(-1) ?? "") as ProbeResult;
}

describe("test-mode database resolution", () => {
  // The temp-file shape Bun actually honours: `new Database(...)` does not
  // interpret SQLite URIs, so the old `file::memory:?cache=shared` was a
  // literal CWD file shared by every test process. The suite DB must be a
  // real file under the temp dir, unique per process.
  const TEST_DB_SHAPE = /subshell-test-\d+-[0-9a-f-]{36}\.db$/;

  test("this very suite is pointed at a per-process temp database file", () => {
    expect(IS_TEST).toBe(true);
    expect(DATABASE_PATH.startsWith(tmpdir())).toBe(true);
    expect(DATABASE_PATH).toMatch(TEST_DB_SHAPE);
    expect(SUBSHELL_SERVER_DATA_DIR.startsWith(tmpdir())).toBe(true);
  });

  // The regression this whole flag exists for: `.env.example` ships a
  // DATABASE_PATH line, Bun loads `.env` before the test preload runs, and the
  // old "set it only when absent" rule therefore handed the suites the
  // developer's live database to create and delete rows in.
  test("SUBSHELL_TEST_MODE overrides a configured DATABASE_PATH rather than deferring to it", () => {
    const result = probeConstants({
      SUBSHELL_TEST_MODE: "1",
      NODE_ENV: "development",
      DATABASE_PATH: "./data/subshell.db",
      SUBSHELL_SERVER_DATA_DIR: "./data",
    });

    expect(result.IS_TEST).toBe(true);
    expect(result.DATABASE_PATH).toMatch(TEST_DB_SHAPE);
    expect(result.DATABASE_PATH.startsWith(tmpdir())).toBe(true);
    expect(result.SUBSHELL_SERVER_DATA_DIR).not.toBe("./data");
    expect(result.SUBSHELL_SERVER_DATA_DIR.startsWith(tmpdir())).toBe(true);
  });

  test("NODE_ENV=test alone is enough, without the preload's flag", () => {
    const result = probeConstants({ NODE_ENV: "test", DATABASE_PATH: "./data/subshell.db" });

    expect(result.IS_TEST).toBe(true);
    expect(result.DATABASE_PATH).toMatch(TEST_DB_SHAPE);
  });

  test("two test processes get DIFFERENT temp database files", () => {
    // Regression guard for the SQLITE_BUSY wars: the old shared URI string
    // made every test process open one literal file concurrently.
    const env = { SUBSHELL_TEST_MODE: "1", NODE_ENV: "development" };
    const a = probeConstants(env).DATABASE_PATH;
    const b = probeConstants(env).DATABASE_PATH;

    expect(a).toMatch(TEST_DB_SHAPE);
    expect(b).toMatch(TEST_DB_SHAPE);
    expect(a).not.toBe(b);
  });

  test("outside test mode the configured DATABASE_PATH is honoured", () => {
    const result = probeConstants({ NODE_ENV: "development", DATABASE_PATH: "/srv/subshell/subshell.db" });

    expect(result.IS_TEST).toBe(false);
    expect(result.DATABASE_PATH).toBe("/srv/subshell/subshell.db");
    expect(result.SUBSHELL_SERVER_DATA_DIR).toBe("/srv/subshell");
  });

  test("outside test mode an unset DATABASE_PATH still defaults to ./data/subshell.db", () => {
    const result = probeConstants({ NODE_ENV: "development" });

    expect(result.IS_TEST).toBe(false);
    expect(result.DATABASE_PATH).toBe("./data/subshell.db");
    // The derived data dir must be ABSOLUTE: it is handed to harness
    // processes (`--mcp-config`, SUBSHELL_DATA_DIR) and to tmux's pipe-pane
    // shell, all of which resolve paths against a *different* cwd than the
    // backend's. A relative "./data" pointed claude at
    // <subshell-cwd>/data/mcp/<id>.json, which never exists — subshells died
    // in milliseconds with "MCP config file not found".
    expect(result.SUBSHELL_SERVER_DATA_DIR).toBe(join(result.cwd, "data"));
  });

  test("a relative SUBSHELL_SERVER_DATA_DIR override is resolved against the process cwd", () => {
    const result = probeConstants({ NODE_ENV: "development", SUBSHELL_SERVER_DATA_DIR: "var/subshell" });

    expect(result.IS_TEST).toBe(false);
    expect(result.SUBSHELL_SERVER_DATA_DIR).toBe(join(result.cwd, "var/subshell"));
  });

  test("an absolute SUBSHELL_SERVER_DATA_DIR passes through untouched", () => {
    const result = probeConstants({ NODE_ENV: "development", SUBSHELL_SERVER_DATA_DIR: "/srv/subshell-data" });

    expect(result.SUBSHELL_SERVER_DATA_DIR).toBe("/srv/subshell-data");
  });
});
