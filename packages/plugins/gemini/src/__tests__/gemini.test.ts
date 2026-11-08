import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "Gemini",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/gemini/bin/gemini", cwd: "/work/project", subshellName: "Example" };

describe("Gemini CLI", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("gemini");
    expect(manifest.detect?.binaryName).toBe("gemini");
    expect(manifest.detect?.envOverride).toBe("GEMINI_PATH");
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.capabilities()).toEqual(["mcp", "settings"]);
  });

  it("starts the interactive TUI bare by default", () => {
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary]);
  });

  it("maps settings to verified flags and preserves whole argv tokens", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { model: "gemini pro", approvalMode: "auto_edit" }, flags: ["--skip-trust"] }),
        extraFlags: ["-i"],
      }),
    ).toEqual([launch.binary, "--model", "gemini pro", "--approval-mode", "auto_edit", "--skip-trust", "-i"]);
  });

  it("renders a manual one-time MCP registration for the pane's own argv", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/usr/bin/subshell", args: ["mcp"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    expect(setup.steps[0]?.command).toContain("gemini mcp add");
    expect(setup.steps[0]?.command).toContain("--scope user");
    // Gemini's parser rejects a `--` separator, so the server name and the
    // shell-quoted argv follow the options directly.
    expect(setup.steps[0]?.command).not.toContain(" -- ");
    expect(setup.steps[0]?.command).toBe("gemini mcp add --scope user subshell '/usr/bin/subshell' 'mcp'");
    expect(setup.steps[1]?.command).toBe("gemini mcp remove --scope user subshell");
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });
});
