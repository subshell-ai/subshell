import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PluginCapability, type SubshellPlugin } from "../index.js";

/**
 * `capabilities()` is what the host branches on, so a declaration that
 * disagrees with the members present is a bug that surfaces late: a plugin
 * claiming `resume` without a `resume` object produces a restart that starts a
 * fresh conversation while looking like it continued one.
 */
function plugin(caps: PluginCapability[], over: Partial<SubshellPlugin> = {}): SubshellPlugin {
  return {
    buildCommand: () => [],
    validateProfile: () => ({ valid: true, issues: [] }),
    capabilities: () => caps,
    ...over,
  };
}

describe("capabilityMismatches", () => {
  it("is silent when a bare plugin declares nothing", () => {
    expect(capabilityMismatches(plugin([]))).toEqual([]);
  });

  it("catches a capability declared but not implemented", () => {
    expect(capabilityMismatches(plugin(["resume"]))[0]).toContain('declares the "resume" capability');
  });

  it("catches a capability implemented but not declared", () => {
    const p = plugin([], { resume: { allocateHarnessSessionId: () => "x", resumePath: () => "/p" } });
    expect(capabilityMismatches(p)[0]).toContain('implements "resume" members');
  });

  it("accepts either MCP dialect for the mcp capability", () => {
    // hermes and pi have manual steps only; codex and opencode render a file.
    // Both are "mcp", which is why the check cannot look for one member.
    expect(capabilityMismatches(plugin(["mcp"], { mcpSetup: () => ({ mode: "auto", summary: "" }) }))).toEqual([]);
    expect(capabilityMismatches(plugin(["mcp"], { mcpRegistration: () => ({ fileContent: "" }) }))).toEqual([]);
  });

  it("treats supportsAttentionHooks:false as not implemented", () => {
    expect(capabilityMismatches(plugin(["attention"], { supportsAttentionHooks: false }))).toHaveLength(1);
    expect(capabilityMismatches(plugin([], { supportsAttentionHooks: false }))).toEqual([]);
  });

  it("reports every mismatch, not just the first", () => {
    expect(capabilityMismatches(plugin(["resume", "settings", "attention"]))).toHaveLength(3);
  });

  it("passes a fully consistent plugin", () => {
    const p = plugin(["mcp", "resume", "attention", "settings"], {
      mcpSetup: () => ({ mode: "auto", summary: "" }),
      resume: { allocateHarnessSessionId: () => "x", resumePath: () => "/p" },
      supportsAttentionHooks: true,
      profileSettings: () => [],
    });
    expect(capabilityMismatches(p)).toEqual([]);
  });
});
