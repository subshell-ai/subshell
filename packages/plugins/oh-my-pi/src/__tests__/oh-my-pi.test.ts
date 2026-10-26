import { describe, expect, it } from "bun:test";
import { capabilityMismatches, type PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());
const preset: PresetDefinition = { name: "Default", env: {}, flags: [], settings: null, configIsolation: false };
const input = { binary: "/home/user/.bun/bin/omp", cwd: "/tmp/project", subshellName: "Fix auth", preset };

describe("Oh My Pi", () => {
  it("detects omp independently of pi", () => {
    expect(manifest.id).toBe("oh-my-pi");
    expect(manifest.name).toBe("Oh My Pi");
    expect(manifest.detect).toEqual({
      binaryName: "omp",
      envOverride: "OMP_PATH",
      knownPaths: [".bun/bin/omp", ".local/bin/omp"],
    });
    expect(capabilityMismatches(plugin, "agent-harness")).toEqual([]);
    expect(plugin.resume).toBeUndefined();
    expect(plugin.supportsAttentionHooks).not.toBe(true);
  });

  it("opens the interactive CLI without unsupported name or resume flags", () => {
    expect(plugin.buildCommand(input)).toEqual([input.binary]);
  });

  it("maps settings and preserves each argv token", () => {
    expect(
      plugin.buildCommand({
        ...input,
        preset: {
          ...preset,
          settings: { model: "sonnet", provider: "anthropic", thinking: "high" },
          flags: ["--append-system-prompt", "Keep it simple; $(false)"],
        },
        extraFlags: ["--no-session"],
      }),
    ).toEqual([
      input.binary,
      "--model",
      "sonnet",
      "--provider",
      "anthropic",
      "--thinking",
      "high",
      "--append-system-prompt",
      "Keep it simple; $(false)",
      "--no-session",
    ]);
  });

  it("ignores empty and non-string settings", () => {
    expect(
      plugin.buildCommand({ ...input, preset: { ...preset, settings: { model: "", provider: false, thinking: 3 } } }),
    ).toEqual([input.binary]);
  });

  it("ships a native MCP extension using the target host's executable and inherited credentials", () => {
    const launch = { command: "/opt/Subshell Client/subshell", args: ["mcp", "argument with spaces"] };
    const registration = plugin.mcpRegistration?.(launch, "/tmp/subshell config.json");
    if (!registration) throw new Error("Missing MCP registration");
    const files = registration?.files ?? {};
    expect(JSON.parse(files["mcp.json"] ?? "{}")).toEqual({ mcpServers: { subshell: { type: "stdio", ...launch } } });
    expect(files["mcp.json"]).toBe(registration.fileContent);
    expect(JSON.parse(files["package.json"] ?? "{}").omp.extensions).toEqual(["bridge.mjs"]);
    expect(files["bridge.mjs"] ?? "").toContain("export default function");
    expect(registration?.env).toBeUndefined();
    expect(plugin.buildCommand({ ...input, mcp: registration })).toEqual([
      input.binary,
      "--extension",
      "/tmp/subshell config.json.d",
    ]);
    expect(plugin.mcpSetup?.(launch).mode).toBe("auto");
    // The host enforces these companion-file bounds on local and remote nodes.
    expect(Object.keys(files).length).toBeLessThanOrEqual(8);
    for (const [name, content] of Object.entries(files)) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+\.(mjs|py|json)$/);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("validates preset inputs", () => {
    expect(plugin.validatePreset(preset).valid).toBe(true);
    expect(plugin.validatePreset({ ...preset, env: { INVALID: 3 as unknown as string } }).valid).toBe(false);
  });
});
