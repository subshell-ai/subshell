import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "Qwen Code",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/qwen/bin/qwen", cwd: "/work/project", subshellName: "Example" };

describe("Qwen Code", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("qwen-code");
    expect(manifest.detect?.binaryName).toBe("qwen");
    expect(manifest.detect?.envOverride).toBe("QWEN_PATH");
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
        preset: preset({ settings: { model: "qwen max", workflowMode: "on" }, flags: ["--chat-recording"] }),
        extraFlags: ["-i"],
      }),
    ).toEqual([launch.binary, "--model", "qwen max", "--workflow-mode", "on", "--chat-recording", "-i"]);
  });

  it("renders a manual one-time MCP registration for the pane's own argv", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/usr/bin/subshell", args: ["mcp"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    expect(setup.steps[0]?.command).toContain("qwen mcp add");
    // Qwen's `mcp add` already writes to user scope by default, so the step
    // carries no --scope flag; and its parser rejects a `--` separator before
    // the server argv (verified on 0.27.0: "Not enough non-option arguments").
    expect(setup.steps[0]?.command).not.toContain("--scope");
    expect(setup.steps[0]?.command).not.toContain(" -- ");
    expect(setup.steps[0]?.command).toBe("qwen mcp add subshell '/usr/bin/subshell' 'mcp'");
    expect(setup.steps[1]?.command).toBe("qwen mcp remove subshell");
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });

  it("states the resume caveat against 0.27.0's recording-is-on default", () => {
    // 0.27.0 resolves chatRecording as `argv ?? settings ?? true`, so --resume
    // fails only when recording was DISABLED. This pins the corrected wording
    // so the old "needs --chat-recording" framing cannot quietly return.
    if (!plugin.suggestedFlags) throw new Error("Missing suggested flags");
    const resume = plugin.suggestedFlags().find((f) => f.flag === "--resume");
    expect(resume?.description).toContain("disabled");
    expect(resume?.description).not.toContain("needs --chat-recording");
  });
});
