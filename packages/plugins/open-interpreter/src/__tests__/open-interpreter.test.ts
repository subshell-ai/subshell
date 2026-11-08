import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "Open Interpreter",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/oi/bin/interpreter", cwd: "/work/project", subshellName: "Example" };

describe("Open Interpreter", () => {
  it("detects the official binary and advertises only implemented capabilities", () => {
    expect(manifest.id).toBe("open-interpreter");
    expect(manifest.detect?.binaryName).toBe("interpreter");
    expect(manifest.detect?.envOverride).toBe("INTERPRETER_PATH");
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.capabilities()).toEqual(["mcp", "settings"]);
  });

  it("starts the interactive TUI bare by default", () => {
    // 0.0.59 opens its TUI on a bare run (its help: "if no subcommand is
    // specified, options will be forwarded to the interactive CLI"), so the
    // launch adds nothing of its own.
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary]);
  });

  it("maps the model setting to the verified -m/--model flag", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { model: "gpt-5.1-codex" } }),
      }),
    ).toEqual([launch.binary, "--model", "gpt-5.1-codex"]);
  });

  it("preserves whole argv tokens and appends extra flags", () => {
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ flags: ["--sandbox", "read-only"] }),
        extraFlags: ["--no-alt-screen"],
      }),
    ).toEqual([launch.binary, "--sandbox", "read-only", "--no-alt-screen"]);
  });

  it("renders a manual MCP registration for the pane's own argv", () => {
    if (!plugin.mcpSetup) throw new Error("Missing MCP setup");
    const setup = plugin.mcpSetup({ command: "/usr/bin/subshell", args: ["mcp"] });
    expect(setup.mode).toBe("manual");
    if (setup.mode !== "manual") throw new Error("Expected manual MCP setup");
    // 0.0.59's `mcp add` takes the stdio command and its args after a `--`
    // separator (its own "no servers configured" hint shows that form), and a
    // live sandboxed round trip stored command+args under
    // [mcp_servers.subshell] in config.toml. Remove takes the name alone.
    expect(setup.steps[0]?.command).toContain("interpreter mcp add");
    expect(setup.steps[0]?.command).toContain(" -- ");
    expect(setup.steps[0]?.command).toBe("interpreter mcp add subshell -- '/usr/bin/subshell' 'mcp'");
    expect(setup.steps[1]?.command).toBe("interpreter mcp remove subshell");
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });

  it("states the approval and config reality against 0.0.59's own help", () => {
    // 0.0.59 has NO `--auto-approve` switch and no top-level `--resume` flag:
    // approval is `--ask-for-approval <on-request|never>` plus
    // `--approve-for-me` (which reviews instead of asking), resuming is the
    // `resume` SUBCOMMAND (a token that doesn't start with `-` can't survive
    // the flag rows' pairing on re-edit, so it is not a suggestion the form
    // can keep), and `-c/--config` takes dotted
    // TOML overrides. Suggestions must not invent a flag.
    if (!plugin.suggestedFlags) throw new Error("Missing suggested flags");
    const flags = plugin.suggestedFlags();
    expect(flags.some((f) => f.flag.startsWith("--auto-approve"))).toBe(false);
    expect(flags.some((f) => f.flag === "--resume")).toBe(false);
    expect(flags.some((f) => f.flag.startsWith("resume"))).toBe(false);
    const review = flags.find((f) => f.flag === "--approve-for-me");
    expect(review?.description).toContain("workspace-write");
    const never = flags.find((f) => f.flag === "--ask-for-approval never");
    expect(never?.description).toContain("failures");
    expect(never?.description).not.toContain("sandbox");
    const config = flags.find((f) => f.flag.startsWith("-c"));
    expect(config?.description).toContain("TOML");
  });
});
