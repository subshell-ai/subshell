import { describe, expect, it } from "bun:test";
import { readCommandBounded } from "../bounded-exec.js";

/**
 * The regression these exist for: `setTimeout(() => proc.kill())` around an
 * unraced `await new Response(proc.stdout).text()` is not a deadline, because
 * killing a process does not close a pipe its children still hold.
 */
describe("readCommandBounded", () => {
  it("returns stdout and the exit code", async () => {
    const result = await readCommandBounded(["/bin/sh", "-c", "echo hello; exit 0"], 4000);
    expect(result?.text.trim()).toBe("hello");
    expect(result?.exitCode).toBe(0);
  });

  it("reports a non-zero exit rather than hiding it", async () => {
    const result = await readCommandBounded(["/bin/sh", "-c", "exit 7"], 4000);
    expect(result?.exitCode).toBe(7);
  });

  it("returns null when the command cannot be spawned", async () => {
    expect(await readCommandBounded(["/nonexistent/tool"], 4000)).toBeNull();
  });

  it("gives up on a slow command", async () => {
    const started = Date.now();
    expect(await readCommandBounded(["/bin/sh", "-c", "sleep 30"], 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("gives up even when a CHILD holds stdout open after the parent is killed", async () => {
    // The exact shape that defeated the old pattern: the shell exits at once,
    // but its background child inherits the pipe and keeps it open.
    const started = Date.now();
    expect(await readCommandBounded(["/bin/sh", "-c", "sleep 30 & exit 0"], 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
