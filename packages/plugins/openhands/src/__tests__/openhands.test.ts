import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "OpenHands",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/oh/bin/openhands", cwd: "/work/project", subshellName: "Example" };

describe("OpenHands", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("openhands");
    expect(manifest.detect?.binaryName).toBe("openhands");
    expect(manifest.detect?.envOverride).toBe("OPENHANDS_PATH");
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    // SDK 1.21.0's --help exposes no settings flag, so this plugin claims
    // nothing but MCP and must not grow a `settings` capability silently.
    expect(plugin.capabilities()).toEqual(["mcp"]);
  });

  it("starts the interactive TUI bare by default", () => {
    // A bare run is textual UI mode (its own help), ALIVE in a detached tmux
    // session, so the launch adds nothing of its own.
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary]);
  });

  it("ignores settings and preserves whole argv tokens and extra flags", () => {
    // The plugin ships no preset settings; settings the server still sends
    // must not leak into argv, and stored tokens pass through untouched.
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { model: "some-model" }, flags: ["--last"] }),
        extraFlags: ["--headless"],
      }),
    ).toEqual([launch.binary, "--last", "--headless"]);
  });

  it("renders a manual MCP registration for the pane's own argv", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/usr/bin/subshell", args: ["mcp"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    // SDK 1.21.0's `mcp add` takes --transport stdio, the command as the
    // target, and the args after a `--` separator; a live sandboxed round trip
    // stored command+args in ~/.openhands/mcp.json, and `mcp remove` takes the
    // name alone.
    expect(setup.steps[0]?.command).toContain("openhands mcp add");
    expect(setup.steps[0]?.command).toContain("--transport stdio");
    expect(setup.steps[0]?.command).toContain(" -- ");
    expect(setup.steps[0]?.command).toBe("openhands mcp add subshell --transport stdio '/usr/bin/subshell' -- 'mcp'");
    expect(setup.steps[1]?.command).toBe("openhands mcp remove subshell");
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });

  it("states only what SDK 1.21.0's own help verifies", () => {
    // No settings surface exists (model and provider are configured in the
    // TUI, and the LLM_* variables only apply with --override-with-envs), and
    // every suggested flag must carry its verified constraint so a preset
    // author is not told `--json` or `--headless` works alone.
    expect(plugin.presetSettings).toBeUndefined();
    if (!plugin.suggestedFlags) throw new Error("Missing suggested flags");
    const flags = plugin.suggestedFlags();
    expect(flags.map((f) => f.flag)).toEqual(["--last", "--always-approve", "--headless", "--json"]);
    expect(flags.find((f) => f.flag === "--last")?.description).toContain("--resume");
    expect(flags.find((f) => f.flag === "--headless")?.description).toContain("--task");
    expect(flags.find((f) => f.flag === "--json")?.description).toContain("headless");
    if (!plugin.suggestedEnv) throw new Error("Missing suggested env");
    const env = plugin.suggestedEnv();
    expect(env.some((e) => e.key === "OPENHANDS_SUPPRESS_BANNER")).toBe(true);
    expect(env.find((e) => e.key === "LLM_MODEL")?.description).toContain("--override-with-envs");
    expect(env.find((e) => e.key === "LLM_API_KEY")?.description).toContain("--override-with-envs");
  });
});
