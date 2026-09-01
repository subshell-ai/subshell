import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logReplayStartOffset } from "@/services/nodes/log-tail.js";

/**
 * logReplayStartOffset — the attach-time replay window. The WS tail reads
 * from the returned offset to the end of file, so the bytes from the offset
 * onward must be exactly the last N lines.
 */
describe("logReplayStartOffset", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-tail-"));
  const written: string[] = [];
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function log(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    written.push(p);
    return p;
  }

  async function tailFrom(p: string, lines: number): Promise<string> {
    const off = await logReplayStartOffset(p, lines);
    return (await Bun.file(p).slice(off).text())
      .split("\n")
      .filter((l) => l !== "")
      .join("|");
  }

  it("returns 0 for files at or under the cap (nothing to prune)", async () => {
    const p = log("small.log", "a\nb\nc\n");
    expect(await logReplayStartOffset(p, 3)).toBe(0);
    expect(await logReplayStartOffset(p, 100)).toBe(0);
  });

  it("starts exactly at the first kept line (trailing-newline logs)", async () => {
    const p = log("nl.log", "l1\nl2\nl3\nl4\nl5\n");
    expect(await tailFrom(p, 2)).toBe("l4|l5");
    expect(await tailFrom(p, 1)).toBe("l5");
    expect(await tailFrom(p, 100)).toBe("l1|l2|l3|l4|l5");
  });

  it("handles a final line without a trailing newline", async () => {
    const p = log("partial.log", "l1\nl2\nl3\nfinal-no-nl");
    expect(await tailFrom(p, 2)).toBe("l3|final-no-nl");
  });

  it("bounds a windowed file with fewer line-count than requested to the window (never the whole file)", async () => {
    // One 300 KB line pushes the file past LOG_TAIL_BYTES: the line count is
    // computed inside the window, so the answer is the window start — bounded
    // output that may begin mid-line (documented degenerate case).
    const p = log("oneline.log", `${"x".repeat(10)}\n${"y".repeat(300_000)}`);
    const off = await logReplayStartOffset(p, 2);
    expect(off).toBeGreaterThan(0);
    expect((await Bun.file(p).slice(off).text()).length).toBeLessThanOrEqual(256 * 1024);
  });

  it("lands exactly on the final line of a huge log", async () => {
    const p = log("huge.log", `${"z".repeat(300_000)}\ntail\n`);
    const off = await logReplayStartOffset(p, 1);
    expect(await Bun.file(p).slice(off).text()).toBe("tail\n");
  });

  it("reads a missing file as 0 (caller tails from the beginning, as before)", async () => {
    expect(await logReplayStartOffset(join(dir, "nope.log"), 100)).toBe(0);
  });

  it("empty file returns 0", async () => {
    const p = log("empty.log", "");
    expect(await logReplayStartOffset(p, 100)).toBe(0);
  });
});
