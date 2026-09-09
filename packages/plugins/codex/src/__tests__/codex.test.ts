import { describe, expect, it } from "bun:test";
import type { McpLaunchSpec, ProfileDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

function profile(overrides: Partial<ProfileDefinition> = {}): ProfileDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

const launch: McpLaunchSpec = { command: "/opt/subshell/subshell-mcp", args: [] };
const bunLaunch: McpLaunchSpec = { command: "/usr/bin/bun", args: ["/opt/subshell/dist/mcp/main.js"] };

describe("CodexPlugin", () => {
  it("has stable metadata", () => {
    // Identity moved to package.json so the host can list and detect this
    // plugin without importing or running a line of it.
    expect(manifest.id).toBe("codex");
    expect(manifest.name).toBe("Codex");
    expect(manifest.type).toBe("agent-harness");
    expect(manifest.detect?.binaryName).toBe("codex");
    expect(manifest.detect?.envOverride).toBe("CODEX_PATH");
  });

  it("buildCommand: bare launch with no profile extra", () => {
    expect(
      plugin.buildCommand({ binary: "/usr/bin/codex", cwd: "/tmp/ws", subshellName: "", profile: profile() }),
    ).toEqual(["/usr/bin/codex"]);
  });

  it("buildCommand: maps settings to flags, then profile and extra flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "ignored",
      profile: profile({
        settings: { model: "gpt-5-codex", sandbox: "workspace-write", askForApproval: "never" },
        flags: ["--search"],
      }),
      extraFlags: ["-p", "work"],
    });
    expect(cmd).toEqual([
      "/usr/bin/codex",
      "-m",
      "gpt-5-codex",
      "-s",
      "workspace-write",
      "-a",
      "never",
      "--search",
      "-p",
      "work",
    ]);
  });

  it("buildCommand: sandbox/approval combos pass through verbatim", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ settings: { sandbox: "read-only", askForApproval: "on-request" } }),
    });
    expect(cmd).toEqual(["/usr/bin/codex", "-s", "read-only", "-a", "on-request"]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ flags: ['-c mcp_servers.foo.args=["a b"]'] }),
    });
    expect(cmd).toEqual(["/usr/bin/codex", '-c mcp_servers.foo.args=["a b"]']);
  });

  it("buildCommand: ignores non-string settings values", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ settings: { model: 42, sandbox: "", askForApproval: false } }),
    });
    expect(cmd).toEqual(["/usr/bin/codex"]);
  });

  it("buildCommand: order is settings → mcp args → profile flags → extraFlags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      profile: profile({ settings: { model: "gpt-5" }, flags: ["--search"] }),
      mcp: {
        fileContent: "",
        args: ["-c", 'mcp_servers.subshell.command="/opt/subshell/subshell-mcp"'],
      },
      extraFlags: ["-p", "work"],
    });
    expect(cmd).toEqual([
      "/usr/bin/codex",
      "-m",
      "gpt-5",
      "-c",
      'mcp_servers.subshell.command="/opt/subshell/subshell-mcp"',
      "--search",
      "-p",
      "work",
    ]);
  });

  it("buildCommand: no resume/subshell-id flags — restarts always start fresh", () => {
    expect((plugin as { resume?: unknown }).resume).toBeUndefined();
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "s",
      profile: profile(),
      harnessSession: { id: "00000000-0000-0000-0000-000000000000", mode: "resume" },
    });
    expect(cmd).toEqual(["/usr/bin/codex"]);
  });

  it("mcpRegistration: -c overrides carry TOML-quoted command and args", () => {
    const reg = plugin.mcpRegistration?.(bunLaunch, "/data/sess.json");
    // Wiring rides the argv, not the env — CODEX_HOME (which holds the user's
    // auth.json) is deliberately never touched.
    expect(reg?.env).toBeUndefined();
    expect(reg?.args).toEqual([
      "-c",
      'mcp_servers.subshell.command="/usr/bin/bun"',
      "-c",
      'mcp_servers.subshell.args=["/opt/subshell/dist/mcp/main.js"]',
    ]);
  });

  it("mcpRegistration: an arg-less launch renders an empty TOML inline array", () => {
    const reg = plugin.mcpRegistration?.(launch, "/data/sess.toml");
    expect(reg?.args).toEqual([
      "-c",
      'mcp_servers.subshell.command="/opt/subshell/subshell-mcp"',
      "-c",
      "mcp_servers.subshell.args=[]",
    ]);
  });

  it("mcpRegistration: file fragment is the manual-setup reference, no secrets", () => {
    const reg = plugin.mcpRegistration?.(bunLaunch, "/data/sess.toml");
    expect(reg?.fileContent).toContain("[mcp_servers.subshell]");
    expect(reg?.fileContent).toContain('command = "/usr/bin/bun"');
    expect(reg?.fileContent).toContain('args = ["/opt/subshell/dist/mcp/main.js"]');
    expect(reg?.fileContent).toContain("MANUAL-SETUP REFERENCE");
    expect(reg?.fileContent).not.toMatch(/KEY|TOKEN/);
  });

  it("reports auto setup", () => {
    expect(plugin.mcpSetup?.(launch).mode).toBe("auto");
  });

  it("validateProfile: delegates to the generic checks", () => {
    expect(plugin.validateProfile(profile({ name: " " })).valid).toBe(false);
    expect(plugin.validateProfile(profile({ flags: ["pure"] })).valid).toBe(false);
    expect(plugin.validateProfile(profile()).valid).toBe(true);
  });
});
