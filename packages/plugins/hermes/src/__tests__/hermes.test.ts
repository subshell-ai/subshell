import { describe, expect, it } from "bun:test";
import type { PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

function preset(overrides: Partial<PresetDefinition> = {}): PresetDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

describe("HermesPlugin", () => {
  it("has stable metadata", () => {
    // Identity moved to package.json so the host can list and detect this
    // plugin without importing or running a line of it.
    expect(manifest.id).toBe("hermes");
    expect(manifest.name).toBe("Hermes Agent");
    expect(manifest.type).toBe("agent-harness");
    expect(manifest.detect?.binaryName).toBe("hermes");
    expect(manifest.detect?.envOverride).toBe("HERMES_PATH");
  });

  it("buildCommand: maps settings to flags, then preset and extra flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/hermes",
      cwd: "/tmp/ws",
      subshellName: "ignored",
      preset: preset({
        settings: { model: "anthropic/claude-sonnet-4.6", provider: "openrouter", toolsets: "web,files" },
        flags: ["--yolo"],
      }),
      extraFlags: ["--worktree"],
    });
    expect(cmd).toEqual([
      "/usr/bin/hermes",
      "-m",
      "anthropic/claude-sonnet-4.6",
      "--provider",
      "openrouter",
      "-t",
      "web,files",
      "--yolo",
      "--worktree",
    ]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/hermes",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ flags: ["--skills", "my skill"] }),
    });
    expect(cmd).toEqual(["/usr/bin/hermes", "--skills", "my skill"]);
  });

  it("validatePreset: delegates to the generic checks", () => {
    expect(plugin.validatePreset(preset({ name: "" })).valid).toBe(false);
    expect(plugin.validatePreset(preset()).valid).toBe(true);
  });

  it("parseVersion: extracts the semver from the real multi-line block", () => {
    // The host probes with a deadline; hermes interprets, because only it
    // knows its harness prints a banner rather than a bare version.
    const raw = "Hermes Agent v0.16.0 (2026.6.5) - upstream 5e01a5db\nProject: /x\n";
    expect(plugin.parseVersion?.(raw)).toBe("0.16.0");
  });

  it("parseVersion: falls back to the whole first line when there is no semver", () => {
    expect(plugin.parseVersion?.("custom-hermes-build\nother\n")).toBe("custom-hermes-build");
  });

  it("parseVersion: answers null for empty output", () => {
    expect(plugin.parseVersion?.("   \n\n")).toBeNull();
  });
});
