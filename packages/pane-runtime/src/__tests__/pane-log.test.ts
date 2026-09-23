import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANE_LOG_FILE_FLAG, PANE_LOG_VERB } from "../pane-log.js";

/**
 * A tiny shim that reads `--file <path>` off its argv and runs the capture
 * child, so the tests exercise the REAL entry contract (`… pane-log --file p`)
 * and the real fd-0 stream rather than calling the function in-process. Bun
 * gives the spawned child the pipe on stdin — exactly what tmux does.
 */
function shim(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "subshell-panlog-"));
  const modPath = new URL("../pane-log.js", import.meta.url).pathname;
  const path = join(dir, "child.ts");
  writeFileSync(
    path,
    `import { appendStdinToLogFile } from ${JSON.stringify(modPath)};
const a = process.argv.slice(2);
const i = a.indexOf("--file");
appendStdinToLogFile(a[i + 1]);
`,
  );
  return { dir, path };
}

/** Spawn the capture child with a writable stdin and return it. */
function spawnChild(shimPath: string, file: string) {
  return Bun.spawn([process.execPath, shimPath, PANE_LOG_FILE_FLAG, file], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
}

describe("pane-log capture child", () => {
  it("exports one verb name and one flag (single source the CLIs and pipePane share)", () => {
    expect(PANE_LOG_VERB).toBe("pane-log");
    expect(PANE_LOG_FILE_FLAG).toBe("--file");
  });

  it("flushes a PARTIAL (newline-less) chunk before stdin closes", async () => {
    // The whole bug, in one assertion. uutils `cat >>` holds a partial write to
    // a regular file until EOF or a large block, which froze the browser live
    // view (a keystroke echo has no newline). This child must land it NOW, with
    // stdin still open — the exact behaviour GNU/BSD `cat` has and uutils lacks.
    const { dir, path } = shim();
    const file = join(dir, "out.log");
    try {
      const child = spawnChild(path, file);
      child.stdin.write("partial-no-eol"); // no newline, and stdin stays open
      const deadline = Date.now() + 2000;
      let seen = "";
      while (Date.now() < deadline) {
        seen = (await Bun.file(file).exists()) ? await Bun.file(file).text() : "";
        if (seen.includes("partial-no-eol")) break;
        await Bun.sleep(20);
      }
      expect(seen).toContain("partial-no-eol"); // flushed WITHOUT EOF
      child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the log 0600 whatever the parent's umask", async () => {
    const { dir, path } = shim();
    const file = join(dir, "mode.log");
    const previous = process.umask(0o000); // deliberately permissive
    try {
      const child = spawnChild(path, file);
      child.stdin.write("x");
      child.stdin.end();
      expect(await child.exited).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends across re-arms (O_APPEND, never truncates)", async () => {
    const { dir, path } = shim();
    const file = join(dir, "append.log");
    try {
      for (const chunk of ["one", "two"]) {
        const child = spawnChild(path, file);
        child.stdin.write(chunk);
        child.stdin.end();
        expect(await child.exited).toBe(0);
      }
      expect(await Bun.file(file).text()).toBe("onetwo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
