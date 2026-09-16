import { afterEach, describe, expect, it } from "bun:test";
import { capabilityMismatches } from "@subshell-ai/plugin-api";
import claudeCode from "@subshell-ai/plugin-claude-code";
import codex from "@subshell-ai/plugin-codex";
import hermes from "@subshell-ai/plugin-hermes";
import opencode from "@subshell-ai/plugin-opencode";
import pi from "@subshell-ai/plugin-pi";
import { createPluginHost } from "../plugin-host.js";
import { allHarnesses, brokenBuiltIns, getHarness, resetRegistryForTests } from "../registry.js";

/**
 * The registry is lazy and contained, and both properties are easy to lose:
 * a top-level `const` would restore eager construction, and a missing
 * try/catch would turn one broken plugin into a failed boot.
 */
describe("the built-in registry", () => {
  afterEach(resetRegistryForTests);

  it("serves every built-in", () => {
    expect(
      allHarnesses()
        .map((h) => h.id)
        .sort(),
    ).toEqual(["claude-code", "codex", "hermes", "opencode", "pi", "terminal"]);
  });

  it("ships with nothing broken", () => {
    // A factory that throws fails that plugin's own tests, so this is empty in
    // any build that got here. It exists so a break is diagnosable rather than
    // showing up as a plugin that silently vanished from the list.
    expect(brokenBuiltIns()).toEqual([]);
  });

  it("finds a plugin by id, and answers undefined for an unknown one", () => {
    expect(getHarness("claude-code")?.name).toBe("Claude Code");
    expect(getHarness("nope")).toBeUndefined();
  });

  it("builds once and reuses it", () => {
    // Identity, not equality: rebuilding per call would re-run five factories
    // on every list render and every launch.
    expect(allHarnesses()).toBe(allHarnesses());
  });

  it("rebuilds after a reset", () => {
    const first = allHarnesses();
    resetRegistryForTests();
    expect(allHarnesses()).not.toBe(first);
  });

  it("carries identity from each manifest, not from plugin code", () => {
    const claude = getHarness("claude-code");
    expect(claude?.binaryName).toBe("claude");
    expect(claude?.installHint.docsUrl).toContain("claude.com");
    expect(getHarness("hermes")?.name).toBe("Hermes Agent");
  });

  it("every built-in's declared capabilities match what it implements", () => {
    // The loader refuses a third-party plugin that gets this wrong, so a
    // built-in that got it wrong would be held to a lower standard than the
    // plugins it ships alongside.
    const host = createPluginHost({ pluginId: "test" });
    for (const [id, factory] of Object.entries({ claudeCode, opencode, hermes, pi, codex })) {
      expect([id, capabilityMismatches(factory(host), "agent-harness")]).toEqual([id, []]);
    }
  });
});
