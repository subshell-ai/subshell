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

describe("Oh My Pi pane titles", () => {
  const parse = plugin.parsePaneTitle;
  if (!parse) throw new Error("Oh My Pi must parse its own pane titles");

  /**
   * omp's brand and run-state separator describe the terminal, not the
   * session. Its pane title is `π <state> <label>`, and the rail mirrored the
   * whole string — `π ⠋ 🚌 Fix the thing` — which reads as a stuck spinner in
   * front of every name (operator screenshot, 2026-11-09). The label keeps
   * its emoji: the generator starts the session name with one.
   */
  it("strips the brand and state separator, keeping the session label", () => {
    expect(parse("π > hmn-vm")).toBe("hmn-vm");
    expect(parse("π ⠋ 🚌 SLASH: Fix the stuck overlay")).toBe("🚌 SLASH: Fix the stuck overlay");
    expect(parse("π ! Waiting for you")).toBe("Waiting for you");
    // The working separator pinned to the static colon (WSL, or a spinner
    // pinned off), the disabled-title form, and the pulse, line and dots
    // spinner styles.
    expect(parse("π : Building")).toBe("Building");
    expect(parse("π: Fix the login bug")).toBe("Fix the login bug");
    expect(parse("π ◑ Building")).toBe("Building");
    expect(parse("π | Building")).toBe("Building");
    expect(parse("π ⠂ Building")).toBe("Building");
  });

  it("answers empty for a title that names no session", () => {
    // The bare brand appears for a moment before the session name lands.
    expect(parse("π")).toBe("");
    expect(parse("π:")).toBe("");
    expect(parse("π ⠋")).toBe("");
  });

  it("keeps a label that merely starts with the brand", () => {
    // No state separator after the brand, so this is not omp's shape.
    expect(parse("π calculus")).toBe("π calculus");
    expect(parse("π-calculus")).toBe("π-calculus");
    expect(parse("π/2 radians")).toBe("π/2 radians");
    // The disabled form always writes a space after its colon.
    expect(parse("π:notes")).toBe("π:notes");
    expect(parse("π:3.14159")).toBe("π:3.14159");
    expect(parse("πrojects dip")).toBe("πrojects dip");
    expect(parse("Fix the login bug")).toBe("Fix the login bug");
  });
});
