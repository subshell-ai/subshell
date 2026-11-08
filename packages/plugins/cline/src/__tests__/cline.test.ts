import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "Cline",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/cline/bin/cline", cwd: "/work/project", subshellName: "Example" };

describe("Cline", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("cline");
    expect(manifest.detect?.binaryName).toBe("cline");
    expect(manifest.detect?.envOverride).toBe("CLINE_PATH");
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.capabilities()).toEqual(["mcp", "settings"]);
  });

  it("starts the interactive TUI with the verified -i switch", () => {
    // Unlike the gemini/qwen pair, Cline's TUI is a switch, not the bare
    // default: 3.0.74 names it `-i, --tui` and the pane launches `cline -i`.
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary, "-i"]);
  });

  it("maps model and reasoning effort to verified flags", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { model: "claude-sonnet-4-5", thinking: "high" } }),
      }),
    ).toEqual([launch.binary, "-i", "--model", "claude-sonnet-4-5", "--thinking", "high"]);
  });

  it("maps the provider setting and preserves whole argv tokens", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { provider: "openrouter" }, flags: ["--retries", "5"] }),
        extraFlags: ["--json"],
      }),
    ).toEqual([launch.binary, "-i", "--provider", "openrouter", "--retries", "5", "--json"]);
  });

  it("renders a manual non-interactive MCP registration for the pane's own argv", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/usr/bin/subshell", args: ["mcp"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    // 3.0.74's `mcp add` opens the registration wizard with fields prefilled,
    // and `--yes` installs without opening it. Its help documents the stdio
    // command and args after a `--` separator, and a live sandboxed round trip
    // confirmed that form (and the bare one) land command+args in
    // cline_mcp_settings.json. Unlike gemini/qwen, Cline ACCEPTS the separator.
    expect(setup.steps[0]?.command).toContain("cline mcp add --yes");
    expect(setup.steps[0]?.command).toContain(" -- ");
    expect(setup.steps[0]?.command).toBe("cline mcp add --yes subshell -- '/usr/bin/subshell' 'mcp'");
    expect(setup.steps[1]?.command).toBe("cline mcp remove subshell");
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });

  it("states the approval and resume reality against 3.0.74's own help", () => {
    // 3.0.74 says the default run starts in act mode with auto-approve
    // ENABLED (`--auto-approve <boolean>` defaults true), so the suggestion
    // must describe turning that default off; a "prompts by default" story
    // would be a fabrication. And `--id` is Cline's own wording for resume.
    if (!plugin.suggestedFlags) throw new Error("Missing suggested flags");
    const autoApprove = plugin.suggestedFlags().find((f) => f.flag === "--auto-approve false");
    expect(autoApprove?.description).toContain("by default");
    expect(autoApprove?.description).not.toContain("prompts by default");
    const resume = plugin.suggestedFlags().find((f) => f.flag.startsWith("--id"));
    expect(resume?.description).toBe("Resume an existing session by ID");
  });
});
