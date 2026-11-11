import { describe, expect, it } from "bun:test";
import type { McpLaunchSpec, PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

function preset(overrides: Partial<PresetDefinition> = {}): PresetDefinition {
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

  it("buildCommand: bare launch with no preset extra", () => {
    expect(
      plugin.buildCommand({ binary: "/usr/bin/codex", cwd: "/tmp/ws", subshellName: "", preset: preset() }),
    ).toEqual(["/usr/bin/codex"]);
  });

  it("labels every monitoring hook for Codex's trust review", () => {
    const args = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset(),
      reporter: bunLaunch,
    });
    const overrides = args.filter((arg) => arg.startsWith("hooks."));
    expect(overrides).toHaveLength(4);
    for (const override of overrides) {
      const parsed = Bun.TOML.parse(override) as {
        hooks: Record<string, { hooks: { statusMessage: string; command: string; timeout: number }[] }[]>;
      };
      const hook = Object.values(parsed.hooks)[0]?.[0]?.hooks[0];
      expect(hook?.statusMessage).toBe("Subshell subagent monitoring");
      expect(hook?.command).toContain("subagents");
      expect(hook?.timeout).toBe(2);
    }
  });

  it("buildCommand: maps settings to flags, then preset and extra flags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "ignored",
      preset: preset({
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
      preset: preset({ settings: { sandbox: "read-only", askForApproval: "on-request" } }),
    });
    expect(cmd).toEqual(["/usr/bin/codex", "-s", "read-only", "-a", "on-request"]);
  });

  it("buildCommand: keeps a multi-word flag value as one token", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ flags: ['-c mcp_servers.foo.args=["a b"]'] }),
    });
    expect(cmd).toEqual(["/usr/bin/codex", '-c mcp_servers.foo.args=["a b"]']);
  });

  it("buildCommand: ignores non-string settings values", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ settings: { model: 42, sandbox: "", askForApproval: false } }),
    });
    expect(cmd).toEqual(["/usr/bin/codex"]);
  });

  it("buildCommand: order is settings → mcp args → preset flags → extraFlags", () => {
    const cmd = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset({ settings: { model: "gpt-5" }, flags: ["--search"] }),
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
      preset: preset(),
      harnessSession: { id: "00000000-0000-0000-0000-000000000000", mode: "resume" },
    });
    expect(cmd).toEqual(["/usr/bin/codex"]);
  });

  it("mcpRegistration: -c overrides carry TOML-quoted command, args and env_vars", () => {
    const reg = plugin.mcpRegistration?.(bunLaunch, "/data/sess.json");
    // Wiring rides the argv, not the env — CODEX_HOME (which holds the user's
    // auth.json) is deliberately never touched.
    expect(reg?.env).toBeUndefined();
    expect(reg?.args).toEqual([
      "-c",
      'mcp_servers.subshell.command="/usr/bin/bun"',
      "-c",
      'mcp_servers.subshell.args=["/opt/subshell/dist/mcp/main.js"]',
      "-c",
      'mcp_servers.subshell.env_vars=["SUBSHELL_API_KEY", "SUBSHELL_BASE_URL", "SUBSHELL_ID", "SUBSHELL_NAME", "SUBSHELL_DATA_DIR", "SUBSHELL_SERVER_DATA_DIR"]',
    ]);
  });

  it("mcpRegistration: an arg-less launch renders an empty TOML inline array", () => {
    const reg = plugin.mcpRegistration?.(launch, "/data/sess.toml");
    expect(reg?.args).toEqual([
      "-c",
      'mcp_servers.subshell.command="/opt/subshell/subshell-mcp"',
      "-c",
      "mcp_servers.subshell.args=[]",
      "-c",
      'mcp_servers.subshell.env_vars=["SUBSHELL_API_KEY", "SUBSHELL_BASE_URL", "SUBSHELL_ID", "SUBSHELL_NAME", "SUBSHELL_DATA_DIR", "SUBSHELL_SERVER_DATA_DIR"]',
    ]);
  });

  it("mcpRegistration: file fragment is the manual-setup reference, no secrets", () => {
    const reg = plugin.mcpRegistration?.(bunLaunch, "/data/sess.toml");
    expect(reg?.fileContent).toContain("[mcp_servers.subshell]");
    expect(reg?.fileContent).toContain('command = "/usr/bin/bun"');
    expect(reg?.fileContent).toContain('args = ["/opt/subshell/dist/mcp/main.js"]');
    expect(reg?.fileContent).toContain("MANUAL-SETUP REFERENCE");
    const config = Bun.TOML.parse(reg?.fileContent ?? "") as {
      mcp_servers: { subshell: { env_vars: string[]; env?: unknown } };
    };
    expect(config.mcp_servers.subshell.env).toBeUndefined();
    expect(config.mcp_servers.subshell.env_vars).toEqual([
      "SUBSHELL_API_KEY",
      "SUBSHELL_BASE_URL",
      "SUBSHELL_ID",
      "SUBSHELL_NAME",
      "SUBSHELL_DATA_DIR",
      "SUBSHELL_SERVER_DATA_DIR",
    ]);
    const command = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset(),
      mcp: reg,
    });
    const override = command.find((arg) => arg.startsWith("mcp_servers.subshell.env_vars="));
    expect(override).toBeDefined();
    expect(Bun.TOML.parse(override ?? "")).toEqual({
      mcp_servers: { subshell: { env_vars: config.mcp_servers.subshell.env_vars } },
    });
  });

  it("reports auto setup", () => {
    expect(plugin.mcpSetup?.(launch).mode).toBe("auto");
  });

  it("validatePreset: delegates to the generic checks", () => {
    expect(plugin.validatePreset(preset({ name: " " })).valid).toBe(false);
    expect(plugin.validatePreset(preset({ flags: ["pure"] })).valid).toBe(false);
    expect(plugin.validatePreset(preset()).valid).toBe(true);
  });

  it("declares native navigation and the hook-picker driver", () => {
    expect(plugin.subagents?.navigation).toBe("native");
    expect(typeof plugin.subagents?.select).toBe("function");
  });

  it("marks every monitoring hook with the compatible reporter verb", () => {
    const args = plugin.buildCommand({
      binary: "/usr/bin/codex",
      cwd: "/tmp/ws",
      subshellName: "",
      preset: preset(),
      reporter: bunLaunch,
    });
    for (const override of args.filter((arg) => arg.startsWith("hooks."))) {
      const parsed = Bun.TOML.parse(override) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      expect(Object.values(parsed.hooks)[0]?.[0]?.hooks[0]?.command).toContain("'subagents'");
    }
  });

  it("selects a child by the id Codex prints, not the server roster's position", async () => {
    const overlay = [
      "Subagents",
      "Select an agent to watch. alt+← previous, alt+→ next.",
      "",
      "› 1. • Main [default] (current)  01a1c7f0-825a-7ce2-8a88-f858e555322f",
      "  2. • /root/reply               01a1c7f0-9481-7e60-af5d-71094b1d4e8a",
      "",
      "  enter select · esc back",
    ].join("\n");
    let typed = "";
    let screen = "› Ask Codex to do anything\nMain [default]";
    const result = await plugin.subagents?.select?.({
      agentId: "01a1c7f0-9481-7e60-af5d-71094b1d4e8a",
      agents: [],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed += text;
          if (text === "/subagents") screen = "› /subagents\nMain [default]";
          else if (text === "\r" && screen.includes("› /subagents")) screen = overlay;
          else if (text === "2") screen = overlay.replace("› 1.", "  1.").replace("  2.", "› 2.");
          else if (text === "\r" && screen.includes("› 2.")) {
            screen = "This sub-agent is controlled by its parent. Direct input is disabled.";
          }
        },
      },
    });
    expect(result).toEqual({ selectedId: "01a1c7f0-9481-7e60-af5d-71094b1d4e8a" });
    expect(typed).toBe("/subagents\r2\r");
  });

  it("finds a picker row whose id wraps in a narrow pane", async () => {
    const overlay = [
      "Subagents",
      "Select an agent to watch. alt+← previous, alt+→ next.",
      "",
      "› 1. • Main [default] (current)  01a1c7f0-825a-7ce2-8a88-",
      "  f858e555322f",
      "  2. • /root/reply               01a1c7f0-9481-7e60-af5d-",
      "  71094b1d4e8a",
      "",
      "  enter select · esc back",
    ].join("\n");
    let typed = "";
    let screen = "› Ask Codex to do anything\nMain [default]";
    const result = await plugin.subagents?.select?.({
      agentId: "01a1c7f0-9481-7e60-af5d-71094b1d4e8a",
      agents: [],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed += text;
          if (text === "/subagents") screen = "› /subagents\nMain [default]";
          else if (text === "\r" && screen.includes("› /subagents")) screen = overlay;
          else if (text === "2") screen = overlay.replace("› 1.", "  1.").replace("  2.", "› 2.");
          else if (text === "\r" && screen.includes("› 2.")) {
            screen = "This sub-agent is controlled by its parent. Direct input is disabled.";
          }
        },
      },
    });
    expect(result).toEqual({ selectedId: "01a1c7f0-9481-7e60-af5d-71094b1d4e8a" });
    expect(typed).toBe("/subagents\r2\r");
  });

  it("accepts a picker that closes on the digit itself", async () => {
    const overlay = [
      "Subagents",
      "Select an agent to watch. alt+← previous, alt+→ next.",
      "",
      "› 1. • Main [default] (current)  01a1c7f0-825a-7ce2-8a88-f858e555322f",
      "  2. • /root/reply               01a1c7f0-9481-7e60-af5d-71094b1d4e8a",
      "",
      "  enter select · esc back",
    ].join("\n");
    let typed = "";
    let screen = "› Ask Codex to do anything\nMain [default]";
    const result = await plugin.subagents?.select?.({
      agentId: "01a1c7f0-9481-7e60-af5d-71094b1d4e8a",
      agents: [],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed += text;
          if (text === "/subagents") screen = "› /subagents\nMain [default]";
          else if (text === "\r" && screen.includes("› /subagents")) screen = overlay;
          else if (text === "2") screen = "This sub-agent is controlled by its parent. Direct input is disabled.";
        },
      },
    });
    expect(result).toEqual({ selectedId: "01a1c7f0-9481-7e60-af5d-71094b1d4e8a" });
    expect(typed).toBe("/subagents\r2");
  });

  it("matches the row's trailing id, not a uuid inside its label", async () => {
    const id1 = "01a1c7f0-825a-7ce2-8a88-f858e555322f";
    const id2 = "01a1c7f0-9481-7e60-af5d-71094b1d4e8a";
    const overlay = [
      "Subagents",
      "Select an agent to watch. alt+← previous, alt+→ next.",
      "",
      `› 1. • Main [default] (current)  ${id1}`,
      `  2. • /root/mentions-${id1}       ${id2}`,
      "",
      "  enter select · esc back",
    ].join("\n");
    let typed = "";
    let screen = "› Ask Codex to do anything\nMain [default]";
    const result = await plugin.subagents?.select?.({
      agentId: id2,
      agents: [],
      pane: {
        read: async () => screen,
        type: async (text) => {
          typed += text;
          if (text === "/subagents") screen = "› /subagents\nMain [default]";
          else if (text === "\r" && screen.includes("› /subagents")) screen = overlay;
          else if (text === "2") screen = "Viewing sub-agent";
        },
      },
    });
    expect(result).toEqual({ selectedId: id2 });
    expect(typed).toBe("/subagents\r2");
  });

  it("returns to Main without touching a draft prompt", async () => {
    let typed = "";
    const result = await plugin.subagents?.select?.({
      agentId: null,
      agents: [],
      pane: {
        read: async () => "› a draft the user hasn't sent\nMain [default]",
        type: async (text) => {
          typed += text;
        },
      },
    });
    expect(result).toEqual({ selectedId: null });
    expect(typed).toBe("");
  });
});
