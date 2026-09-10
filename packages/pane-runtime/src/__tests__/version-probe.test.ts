import { describe, expect, it } from "bun:test";
import { probeVersion } from "../version-probe.js";

/**
 * The deadline is the point. Everything else here pins the behaviour the five
 * hand-rolled implementations had, so replacing them changes nothing but the
 * hang.
 */
describe("probeVersion", () => {
  it("returns trimmed stdout", async () => {
    expect(await probeVersion("/bin/echo", ["1.2.3"])).toBe("1.2.3");
  });

  it("returns null when the tool prints nothing", async () => {
    expect(await probeVersion("/bin/true", [])).toBeNull();
  });

  it("returns null for a binary that does not exist", async () => {
    expect(await probeVersion("/nonexistent/tool", ["--version"])).toBeNull();
  });

  it("keeps output from a tool that exits non-zero, as the old code did", async () => {
    expect(await probeVersion("/bin/sh", ["-c", "echo 9.9.9; exit 3"])).toBe("9.9.9");
  });

  it("gives up rather than hanging", async () => {
    const started = Date.now();
    expect(await probeVersion("/bin/sh", ["-c", "sleep 30"], 200)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("gives up on an absurdly chatty --version instead of shipping megabytes", async () => {
    // The frame-budget case (final review R15): a detect answer carries
    // `rawVersion` inside a result event, and the node link caps every frame
    // at NODE_MAX_FRAME_BYTES — a multi-megabyte version answer is a lost
    // detect round trip (or worse) for a fact that is a nice-to-have. 4 KiB
    // is orders past any real version string, so exceeding it means the tool
    // is not answering the question.
    const started = Date.now();
    const chatty = [
      "-c",
      "i=0; while [ $i -lt 200 ]; do echo 'vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv'; i=$((i+1)); done",
    ];
    expect(await probeVersion("/bin/sh", chatty)).toBeNull();
    // Bounded output must not need the 4 s deadline: the read stops at the
    // cap and the child is killed.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a large-but-under-cap version still reads whole", async () => {
    // ~3 KiB of output — noisy for a version, legal by the cap: the promise
    // is only that OVER-cap answers are refused, not that answers stay short.
    const out = "v".repeat(100);
    const big = ["-c", `i=0; while [ $i -lt 30 ]; do echo '${out}'; i=$((i+1)); done`];
    const text = await probeVersion("/bin/sh", big);
    expect(text?.length).toBe(30 * 101 - 1); // 30 lines joined by \n, trailing newline trimmed
  });
});
