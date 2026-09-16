import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type NetworkPlugin, type PluginCapability, type SubshellPlugin } from "../index.js";

/**
 * `capabilities()` is what the host branches on, so a declaration that
 * disagrees with the members present is a bug that surfaces late: a plugin
 * claiming `resume` without a `resume` object produces a restart that starts a
 * fresh conversation while looking like it continued one.
 */
function harness(caps: PluginCapability[], over: Partial<SubshellPlugin> = {}): SubshellPlugin {
  return {
    buildCommand: () => [],
    validatePreset: () => ({ valid: true, issues: [] }),
    capabilities: () => caps,
    ...over,
  };
}

describe("capabilityMismatches", () => {
  it("is silent when a bare plugin declares nothing", () => {
    expect(capabilityMismatches(harness([]), "agent-harness")).toEqual([]);
  });

  it("catches a capability declared but not implemented", () => {
    expect(capabilityMismatches(harness(["resume"]), "agent-harness")[0]).toContain('declares the "resume" capability');
  });

  it("catches a capability implemented but not declared", () => {
    const p = harness([], { resume: { allocateHarnessSessionId: () => "x", resumePath: () => "/p" } });
    expect(capabilityMismatches(p, "agent-harness")[0]).toContain('implements "resume" members');
  });

  it("accepts either MCP dialect for the mcp capability", () => {
    // hermes and pi have manual steps only; codex and opencode render a file.
    // Both are "mcp", which is why the check cannot look for one member.
    expect(
      capabilityMismatches(harness(["mcp"], { mcpSetup: () => ({ mode: "auto", summary: "" }) }), "agent-harness"),
    ).toEqual([]);
    expect(
      capabilityMismatches(harness(["mcp"], { mcpRegistration: () => ({ fileContent: "" }) }), "agent-harness"),
    ).toEqual([]);
  });

  it("treats supportsAttentionHooks:false as not implemented", () => {
    expect(
      capabilityMismatches(harness(["attention"], { supportsAttentionHooks: false }), "agent-harness"),
    ).toHaveLength(1);
    expect(capabilityMismatches(harness([], { supportsAttentionHooks: false }), "agent-harness")).toEqual([]);
  });

  it("reports every mismatch, not just the first", () => {
    expect(capabilityMismatches(harness(["resume", "settings", "attention"]), "agent-harness")).toHaveLength(3);
  });

  it("passes a fully consistent plugin", () => {
    const p = harness(["mcp", "resume", "attention", "settings"], {
      mcpSetup: () => ({ mode: "auto", summary: "" }),
      resume: { allocateHarnessSessionId: () => "x", resumePath: () => "/p" },
      supportsAttentionHooks: true,
      presetSettings: () => [],
    });
    expect(capabilityMismatches(p, "agent-harness")).toEqual([]);
  });
});

/**
 * The network half. Same rule, a different member table — and one rule the
 * harness half has no equivalent of: a capability belonging to the OTHER type
 * is refused by name, because a plugin built against the wrong half of the
 * contract otherwise loads with whatever it implements unreachable.
 */
function network(caps: PluginCapability[], over: Partial<NetworkPlugin> = {}): NetworkPlugin {
  return {
    capabilities: () => caps,
    status: async () => ({ state: "not-installed", addresses: [], hints: [] }),
    join: async () => ({ state: "joined" }),
    leave: async () => {},
    ...over,
  };
}

describe("capabilityMismatches (network)", () => {
  it("is silent when a bare network plugin declares nothing", () => {
    expect(capabilityMismatches(network([]), "network")).toEqual([]);
  });

  it("refuses a harness capability on a network plugin", () => {
    expect(capabilityMismatches(network(["resume"]), "network")[0]).toContain(
      'declares "resume", which is not a capability of a network plugin',
    );
  });

  it("refuses a network capability on a harness", () => {
    expect(capabilityMismatches(harness(["publish"]), "agent-harness")[0]).toContain(
      'declares "publish", which is not a capability of a agent-harness plugin',
    );
  });

  it("wants publish and unpublish together", () => {
    // A publish nothing can undo is not a capability: disabling the plugin
    // would leave the server exposed with no way back short of the vendor CLI.
    expect(
      capabilityMismatches(network(["publish"], { publish: async () => ({ addresses: [] }) }), "network"),
    ).toHaveLength(1);
    expect(
      capabilityMismatches(
        network(["publish"], { publish: async () => ({ addresses: [] }), unpublish: async () => {} }),
        "network",
      ),
    ).toEqual([]);
  });

  it("catches supervise and guard declared but not implemented", () => {
    expect(capabilityMismatches(network(["supervise", "guard"]), "network")).toHaveLength(2);
  });

  it("passes a fully consistent network plugin", () => {
    const p = network(["publish", "supervise", "guard", "settings"], {
      publish: async () => ({ addresses: [] }),
      unpublish: async () => {},
      supervisedProcess: () => null,
      requestGuard: () => null,
      settingsFields: () => [],
    });
    expect(capabilityMismatches(p, "network")).toEqual([]);
  });
});
