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
});
