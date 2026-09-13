import { describe, expect, it } from "bun:test";
import { validateGenericPreset } from "@subshell-ai/plugin-api";
import type { PresetDefinition } from "../types.js";

function preset(overrides: Partial<PresetDefinition> = {}): PresetDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("validateGenericPreset", () => {
  it("accepts a plain preset", () => {
    expect(validateGenericPreset(preset())).toEqual({ valid: true, issues: [] });
  });

  it("rejects missing or whitespace-only names", () => {
    expect(validateGenericPreset(preset({ name: "" })).issues.map((i) => i.field)).toContain("name");
    expect(validateGenericPreset(preset({ name: "   " })).valid).toBe(false);
  });

  it("rejects non-string env values", () => {
    const result = validateGenericPreset(preset({ env: { X: 1 as unknown as string } }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "env" && i.message.includes("X"))).toBe(true);
  });

  it("rejects flags that do not start with a dash", () => {
    const result = validateGenericPreset(preset({ flags: ["--ok", "nope"] }));
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("nope");
  });
});
