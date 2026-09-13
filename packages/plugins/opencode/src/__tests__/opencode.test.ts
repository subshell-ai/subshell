import { describe, expect, it } from "bun:test";
import type { PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

function preset(overrides: Partial<PresetDefinition> = {}): PresetDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("OpencodePlugin", () => {
  it("has stable metadata", () => {
    // Identity moved to package.json so the host can list and detect this
    // plugin without importing or running a line of it.
    expect(manifest.id).toBe("opencode");
    expect(manifest.name).toBe("OpenCode");
    expect(manifest.type).toBe("agent-harness");
    expect(manifest.detect?.binaryName).toBe("opencode");
    expect(manifest.detect?.envOverride).toBe("OPENCODE_PATH");
  });

  it("buildCommand: bare launch with no preset extra", () => {
    expect(
      plugin.buildCommand({ binary: "/usr/bin/opencode", cwd: "/tmp/ws", subshellName: "", preset: preset() }),
    ).toEqual(["/usr/bin/opencode"]);
  });

  it("buildCommand: maps settings to flags, then preset and extra flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/opencode",
      cwd: "/tmp/ws",
      subshellName: "ignored",
      preset: preset({
        settings: { model: "anthropic/claude-sonnet-4-5", agent: "plan", auto: true },
        flags: ["--pure"],
      }),
      extraFlags: ["--mini"],
    });
    expect(cmd).toEqual([
      "/usr/bin/opencode",
      "-m",
      "anthropic/claude-sonnet-4-5",
      "--agent",
      "plan",
      "--auto",
      "--pure",
      "--mini",
    ]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/opencode",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ flags: ["--prompt", "be nice"] }),
    });
    expect(cmd).toEqual(["/usr/bin/opencode", "--prompt", "be nice"]);
  });

  it("buildCommand: ignores non-string settings values", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/opencode",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ settings: { model: 42, agent: "", auto: "yes" } }),
    });
    expect(cmd).toEqual(["/usr/bin/opencode"]);
  });

  it("validatePreset: delegates to the generic checks", () => {
    expect(plugin.validatePreset(preset({ name: " " })).valid).toBe(false);
    expect(plugin.validatePreset(preset({ flags: ["pure"] })).valid).toBe(false);
    expect(plugin.validatePreset(preset()).valid).toBe(true);
  });
});
