import { describe, expect, it } from "bun:test";
import { ALL_HARNESSES } from "../index.js";

/**
 * The contract `scanOne` depends on: every plugin can say why, and its two
 * views of the same lookup cannot disagree.
 */
describe("every plugin implements detect()", () => {
  for (const plugin of ALL_HARNESSES) {
    it(`${plugin.id} agrees with its own findBinary()`, async () => {
      const result = await plugin.detect();
      expect(result.path).toBe(await plugin.findBinary());
      if (result.path === null) {
        expect(["not-on-path", "override-invalid"]).toContain(result.reason);
      } else {
        expect(result.reason).toBeUndefined();
      }
    });

    it(`${plugin.id} agrees with its own isInstalled()`, async () => {
      const result = await plugin.detect();
      expect(await plugin.isInstalled()).toBe(result.path !== null);
    });
  }
});
