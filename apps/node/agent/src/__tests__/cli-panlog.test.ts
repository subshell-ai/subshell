import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run } from "../cli.js";

/**
 * The `pane-log` VERB as tmux's pipe-pane child invokes it: argv in, pane bytes
 * on stdin, log file on disk. The copy itself is unit-tested in pane-runtime
 * (`pane-log.test.ts`); what lives HERE is the CLI wiring around it — the flag
 * contract `TmuxRunner.pipePane` builds against, and the pre-boot entry (the
 * capture child of a daemon pane must never boot a second daemon or open the
 * agent's SQLite). Only the error paths run in-process: they return before
 * touching stdin; the success path blocks until EOF, so it spawns the real
 * entry — the same shape `subshell mcp`'s entry test uses.
 */
const NODE_MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

describe("pane-log flag contract", () => {
  test("a missing --file is a usage error (2) that names the flag", async () => {
    const r = await run(["pane-log"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--file");
  });

  test("a RELATIVE --file is refused — pipePane always names an absolute path", async () => {
    const r = await run(["pane-log", "--file", "subshells/abc.log"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("absolute");
  });

  test("`--file --force` cannot smuggle a flag in as the path", async () => {
    // The flag parser refuses any value starting with `-`; the absolute-path
    // rule closes it twice. Without both, argv assembled wrong would open (or
    // create) a file literally named `--force` in the child's cwd.
    const r = await run(["pane-log", "--file", "--force"]);
    expect(r.code).toBe(2);
  });

  test("`--file` is valid ONLY for pane-log", () => {
    // Guards the COMMAND_FLAGS registration: a flag that leaked onto another
    // verb would be silently accepted where nobody means it. parseArgs (not
    // run()) — run() catches the UsageError into a CliResult.
    expect(() => parseArgs(["version", "--file", "/tmp/x"])).toThrow(/not valid/);
  });
});

test("pane-log appends stdin to the absolute --file at 0600, without booting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subshell-panlog-cli-"));
  const file = join(dir, "pane.log");
  try {
    const child = Bun.spawn([process.execPath, NODE_MAIN, "pane-log", "--file", file], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Deliberately NO SUBSHELL_CONFIG_HOME/SUBSHELL_DATA_DIR pointing at
      // anything real: the verb must not read config, open a DB, or write a
      // daemon file. A booting verb would error on the missing env or litter
      // the temp dir; both assertions below would then fail.
      cwd: dir,
    });
    child.stdin.write("partial-no-eol");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await Bun.file(file).text()).toBe("partial-no-eol");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Nothing else was written — no config.json, no daemon side files.
    expect(readdirSync(dir)).toEqual(["pane.log"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
