import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset = (overrides: Partial<PresetDefinition> = {}): PresetDefinition => ({
  name: "OpenClaw",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
  ...overrides,
});
const launch = { binary: "/opt/oc/bin/openclaw", cwd: "/work/project", subshellName: "Example" };

describe("OpenClaw", () => {
  it("detects the official binary and advertises no capabilities", () => {
    expect(manifest.id).toBe("openclaw");
    expect(manifest.detect?.binaryName).toBe("openclaw");
    expect(manifest.detect?.envOverride).toBe("OPENCLAW_PATH");
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    // The standing ruling: MCP is deliberately unwired because OpenClaw's
    // MCP config is Gateway-scoped (one registration shared by every OpenClaw
    // session on the host) while a stdio child's SUBSHELL_* credential is
    // baked at spawn, and 2026.11.1's `chat` exposes no settings flag. The
    // plugin must stay capability-free until a per-session route exists.
    expect(plugin.capabilities()).toEqual([]);
  });

  it("launches the embedded TUI through the chat subcommand", () => {
    // 2026.11.1: `chat` is its own alias for `tui --local`, and a sandboxed
    // HOME render on 2026-11-07 showed "local ready" with no Gateway running.
    expect(plugin.buildCommand({ ...launch, preset: preset() })).toEqual([launch.binary, "chat"]);
  });

  it("appends stored flags and extra flags after chat and ignores settings", () => {
    // The plugin ships no preset settings; settings the server still sends
    // must not leak into argv, and stored tokens pass through untouched.
    expect(
      plugin.buildCommand({
        ...launch,
        preset: preset({ settings: { model: "some-model" }, flags: ["--session", "review"] }),
        extraFlags: ["--history-limit", "20"],
      }),
    ).toEqual([launch.binary, "chat", "--session", "review", "--history-limit", "20"]);
  });

  it("rejects presets without a name", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
  });

  it("states only what the 2026.11.1 binary verifies", () => {
    // No settings surface exists (model choice lives in OpenClaw's config,
    // not a launch flag), and there is no MCP setup to render. The plan's
    // suggested `tui` and `resume` rows failed live review: both are top-level
    // SUBCOMMANDS (`openclaw resume [options] [query]`), and a flag row stores
    // only `-`-prefixed tokens that buildCommand appends after `chat`, so
    // neither is an applicable suggestion from the pane and they must not
    // come back. `--session <key>` is the one flag verified in embedded mode:
    // the live render took it and showed the TUI on the named session.
    expect(plugin.presetSettings).toBeUndefined();
    expect(plugin.mcpSetup).toBeUndefined();
    if (!plugin.suggestedFlags) throw new Error("Missing suggested flags");
    const flags = plugin.suggestedFlags();
    expect(flags.map((f) => f.flag)).toEqual(["--session <key>"]);
    expect(flags.some((f) => !f.flag.startsWith("-"))).toBe(false);
    expect(flags.some((f) => f.flag === "tui" || f.flag === "resume" || f.flag.startsWith("--resume"))).toBe(false);
    expect(flags[0]?.description).toContain("session");
    if (!plugin.suggestedEnv) throw new Error("Missing suggested env");
    const env = plugin.suggestedEnv();
    // Both vars are real in the 2026.11.1 bundle: the launcher reads
    // OPENCLAW_CONFIG_PATH (falling back to ~/.openclaw/openclaw.json) and
    // the gateway auth path reads OPENCLAW_GATEWAY_TOKEN. Descriptions must
    // not claim either one matters to an embedded `chat` run.
    expect(env.find((e) => e.key === "OPENCLAW_CONFIG_PATH")?.description).toContain("openclaw.json");
    expect(env.find((e) => e.key === "OPENCLAW_GATEWAY_TOKEN")?.description).toContain("Gateway");
  });
});
