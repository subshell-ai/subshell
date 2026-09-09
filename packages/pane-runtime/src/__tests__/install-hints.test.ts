import { describe, expect, it } from "bun:test";
import { ALL_HARNESSES } from "../index.js";

/**
 * A missing harness is only useful if the UI can say how to get it, so every
 * built-in must carry a real install hint (registry-wide guard: a new plugin
 * without one fails here).
 */
describe("install hints", () => {
  it("every built-in harness ships an install command and docs url", () => {
    expect(ALL_HARNESSES.length).toBeGreaterThan(0);
    for (const h of ALL_HARNESSES) {
      expect(h.installHint.command, h.id).toMatch(/^(curl|npm|bun|brew|winget)/);
      expect(h.installHint.command, h.id).toContain("http");
      expect(h.installHint.docsUrl, h.id).toMatch(/^https:\/\//);
    }
  });
});
