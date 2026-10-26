import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "Grok",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/grok/bin/grok", cwd: "/work/project", subshellName: "Example" };

describe("Grok Build", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("grok-build");
    expect(manifest.detect).toEqual({ binaryName: "grok", envOverride: "GROK_PATH", knownPaths: [".grok/bin/grok"] });
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.capabilities()).toEqual(["mcp", "settings"]);
  });

  it("starts an interactive agent without sharing a leader or enabling auto-approval", () => {
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary, "--no-leader"]);
  });

  it("maps settings and preserves complete argv tokens, including shell metacharacters", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({
          settings: {
            model: "custom model",
            reasoningEffort: "high",
            agent: "/my agents/reviewer.md",
            alwaysApprove: true,
          },
          flags: ["--rules", "don't run $(anything)"],
        }),
        extraFlags: ["--minimal"],
      }),
    ).toEqual([
      launch.binary,
      "--no-leader",
      "--model",
      "custom model",
      "--reasoning-effort",
      "high",
      "--agent",
      "/my agents/reviewer.md",
      "--always-approve",
      "--rules",
      "don't run $(anything)",
      "--minimal",
    ]);
  });

  it("doesn't treat string or false values as approval", () => {
    for (const alwaysApprove of [false, "true"]) {
      expect(plugin.buildCommand({ ...launch, preset: preset({ settings: { model: "", alwaysApprove } }) })).toEqual([
        launch.binary,
        "--no-leader",
      ]);
    }
  });

  it("provides scoped MCP setup with safely quoted executable and arguments", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/opt/it's subshell/subshell", args: ["mcp", "a b", "$(no)"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    expect(setup.steps[0]?.command).toBe(
      "grok mcp add --scope user subshell -- '/opt/it'\\''s subshell/subshell' 'mcp' 'a b' '$(no)'",
    );
    expect(setup.steps[1]?.command).toBe("grok mcp remove --scope user subshell");
    expect(JSON.stringify(setup)).not.toContain("SUBSHELL_API_KEY");
    expect(plugin.mcpRegistration).toBeUndefined();
  });

  it("supports a standalone MCP executable without arguments", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/opt/subshell-mcp", args: [] });
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    expect(setup.steps[0]?.command).toBe("grok mcp add --scope user subshell -- '/opt/subshell-mcp'");
  });

  it("validates ordinary presets", () => {
    expect(plugin.validatePreset(preset()).valid).toBe(true);
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });
});
