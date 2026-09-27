import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NODE_MAX_FRAME_BYTES } from "@internal/subshell-protocol";
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
      // An EMPTY config home, and it is required rather than tidy. `HOME`
      // travels, and `constants.ts` applies the config.env layer at import —
      // so without this the probe reads the DEVELOPER'S OWN
      // ~/.config/subshell-server/config.env and reports their `DATABASE_PATH`
      // instead of the default this suite is asserting. Machine-dependent:
      // green on CI and on a clean checkout, red for anyone who has ever run
      // `subshell-server init`. It is also the rule this repo already
      // documents (apps/server/api/AGENTS.md, and why `e2e/stack.ts` does the
      // same): anything booting the server for test purposes and wanting
      // stock config must OVERRIDE the home, not merely avoid setting vars.
      //
      // Before `...env`, so a case that wants a real config.env can still
      // point this at its own fixture.
      SUBSHELL_SERVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "subshell-constants-probe-cfg-")),
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

/**
 * Fresh-process probe of `TERMINAL_HISTORY_BYTES` and its cap. Same shape
 * and same hygiene as `probeConstants` (bare env, empty config home, temp
 * cwd) for the same reason: the constant parses the environment ONCE at
 * module load, and this suite has already imported it.
 */
function probeHistoryBytes(historyEnv?: string): number {
  const dir = mkdtempSync(join(tmpdir(), "subshell-constants-history-"));
  const script = join(dir, "probe.ts");
  writeFileSync(
    script,
    `import { TERMINAL_HISTORY_BYTES } from ${JSON.stringify(CONSTANTS_MODULE)};\n` +
      `console.log(TERMINAL_HISTORY_BYTES);\n`,
  );

  const proc = Bun.spawnSync(["bun", "run", script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SUBSHELL_SERVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "subshell-constants-history-cfg-")),
      ...(historyEnv === undefined ? {} : { SUBSHELL_TERMINAL_HISTORY_BYTES: historyEnv }),
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout.toString().trim();
  if (proc.exitCode !== 0) {
    throw new Error(`probe failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return Number(stdout.split("\n").at(-1));
}

describe("terminal history clamp — derived from the node-link frame", () => {
  test("an env above the cap clamps to half the node frame ceiling, not to 4 MiB", () => {
    // The window of a REMOTE pane rides one `log_read` JSON result capped at
    // NODE_MAX_FRAME_BYTES with the bytes base64'd at ~4/3: an over-cap
    // value reads as a SUPPRESSED agent result and stalls the full RPC
    // timeout on every attach. The review's defect was an invitation to set
    // 4 MiB against a 1 MiB wire budget.
    expect(probeHistoryBytes("8388608")).toBe(NODE_MAX_FRAME_BYTES >> 1);
  });

  test("a value between the default and the cap passes through: the cap is the wire budget, not the default", () => {
    // 300000 > 262144 (the default) and < 524288 (the cap), so this fails
    // the moment either number moves under someone's feet.
    expect(probeHistoryBytes("300000")).toBe(300000);
  });

  test("the default is untouched by the re-derivation", () => {
    expect(probeHistoryBytes()).toBe(262144);
  });
});
