import { describe, expect, it } from "bun:test";
import type { ProfileDefinition } from "../types.js";
import { validateGenericProfile } from "../validate.js";

function profile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("validateGenericProfile", () => {
  it("accepts a plain profile", () => {
    expect(validateGenericProfile(profile())).toEqual({ valid: true, issues: [] });
  });

  it("rejects missing or whitespace-only names", () => {
    expect(validateGenericProfile(profile({ name: "" })).issues.map((i) => i.field)).toContain("name");
    expect(validateGenericProfile(profile({ name: "   " })).valid).toBe(false);
  });

  it("rejects non-string env values", () => {
    const result = validateGenericProfile(profile({ env: { X: 1 as unknown as string } }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "env" && i.message.includes("X"))).toBe(true);
  });

  it("rejects flags that do not start with a dash", () => {
    const result = validateGenericProfile(profile({ flags: ["--ok", "nope"] }));
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("nope");
  });
});
