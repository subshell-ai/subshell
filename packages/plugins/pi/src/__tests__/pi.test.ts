import { describe, expect, it } from "bun:test";
import type { PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

function preset(overrides: Partial<PresetDefinition> = {}): PresetDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("PiPlugin", () => {
  it("has stable metadata", () => {
    // Identity moved to package.json so the host can list and detect this
    // plugin without importing or running a line of it.
    expect(manifest.id).toBe("pi");
    expect(manifest.name).toBe("pi");
    expect(manifest.type).toBe("agent-harness");
    expect(manifest.detect?.binaryName).toBe("pi");
    expect(manifest.detect?.envOverride).toBe("PI_PATH");
  });

  it("buildCommand: maps settings and forwards the subshell name", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/pi",
      cwd: "/tmp/ws",
      subshellName: "Refactor auth",
      preset: preset({
        settings: { model: "sonnet:high", provider: "anthropic", thinking: "high" },
        flags: ["--offline"],
      }),
      extraFlags: ["--no-session"],
    });
    expect(cmd).toEqual([
      "/usr/bin/pi",
      "--model",
      "sonnet:high",
      "--provider",
      "anthropic",
      "--thinking",
      "high",
      "--name",
      "Refactor auth",
      "--offline",
      "--no-session",
    ]);
  });

  it("buildCommand: no name flag when the subshell name is empty", () => {
    const cmd = plugin.buildCommand({ binary: "/usr/bin/pi", cwd: "/tmp/ws", subshellName: "", preset: preset() });
    expect(cmd).toEqual(["/usr/bin/pi"]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/pi",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ flags: ["--append-system-prompt", "be nice"] }),
    });
    expect(cmd).toEqual(["/usr/bin/pi", "--append-system-prompt", "be nice"]);
  });

  it("validatePreset: delegates to the generic checks", () => {
    expect(plugin.validatePreset(preset({ env: { X: 1 as unknown as string } })).valid).toBe(false);
    expect(plugin.validatePreset(preset()).valid).toBe(true);
  });
});
