import { describe, expect, it } from "bun:test";
import { ALL_HARNESSES } from "../index.js";
import { scanHarnesses } from "../inventory.js";

describe("scanHarnesses", () => {
  it("returns one entry per built-in harness with consistent optionals", async () => {
    const entries = await scanHarnesses();
    expect(entries.map((e) => e.harnessId).sort()).toEqual(ALL_HARNESSES.map((h) => h.id).sort());
    for (const e of entries) {
      expect(typeof e.installed).toBe("boolean");
      if (!e.installed) {
        expect(e.version).toBeUndefined();
        expect(e.binaryPath).toBeUndefined();
      } else if (e.version !== undefined) {
        expect(typeof e.version).toBe("string");
      }
    }
  });
});
