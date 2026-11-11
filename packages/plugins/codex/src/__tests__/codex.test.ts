import { describe, expect, it } from "bun:test";
import type { HarnessSubagentPane, McpLaunchSpec, PresetDefinition } from "@subshell-ai/plugin-api";
import { createTestHost } from "@subshell-ai/plugin-api/testing";
import createPlugin, { manifest } from "../index.js";

const plugin = createPlugin(createTestHost());

function preset(overrides: Partial<PresetDefinition> = {}): PresetDefinition {
  return { name: "p", env: {}, flags: [], settings: null, configIsolation: false, ...overrides };
}

const launch: McpLaunchSpec = { command: "/opt/subshell/subshell-mcp", args: [] };
const bunLaunch: McpLaunchSpec = { command: "/usr/bin/bun", args: ["/opt/subshell/dist/mcp/main.js"] };

type PickerRow = { name: string; id: string };

const MAIN_ROW: PickerRow = { name: "Main [default]", id: "01a1c6b8-2a4c-77f2-a828-5eba0903f64d" };

function childRow(index: number): PickerRow {
  return { name: `/root/child_${index}`, id: `01a1c7f0-825a-7ce2-8a88-${String(index).padStart(12, "0")}` };
}

/**
 * A stand-in for Codex's `/subagents` picker: eight painted rows over the whole
 * roster, Home/PageDown/arrow navigation, and Enter following the highlight.
 * The driver is pinned against the shape the real TUI has, not against a page
 * that happens to fit.
 */
function pickerHarness(
  rows: readonly PickerRow[],
  options: { open?: boolean; selected?: number; currentRow?: number; formatId?: (id: string) => string } = {},
) {
  const typed: string[] = [];
  const maxVisible = 8;
  let open = options.open ?? false;
  let selected = options.selected ?? 0;
  let top = open ? Math.max(0, Math.min(selected + 1 - maxVisible, rows.length - maxVisible)) : 0;
  let composer = "";
  const ensureVisible = () => {
    if (selected < top) top = selected;
    else if (selected >= top + maxVisible) top = selected + 1 - maxVisible;
  };
  const renderPicker = () => {
    const visible = rows.slice(top, top + maxVisible);
    const lines = ["  Subagents", "  Select an agent to watch. alt+← previous, alt+→ next.", ""];
    if (top > 0) lines.push("↑");
    for (const [offset, row] of visible.entries()) {
      const index = top + offset + 1;
      const marker = index - 1 === selected ? "›" : " ";
      const suffix = index - 1 === (options.currentRow ?? 0) ? " (current)" : "";
      const id = options.formatId?.(row.id) ?? row.id;
      lines.push(`${marker} ${index}. • ${row.name}${suffix}  ${id}`);
    }
    if (top + visible.length < rows.length) lines.push("↓");
    lines.push("  enter select · esc back");
    return lines.join("\n");
  };
  const view = () => {
    if (open) return renderPicker();
    if (selected > 0) {
      return [
        "› Viewing sub-agent — direct input is disabled",
        `  GPT-6.1-Sol low · ~/projects/hmn-vm · \`${rows[selected]?.name}\``,
        "  ← for agents · ? for shortcuts",
      ].join("\n");
    }
    return [
      composer === "/subagents" ? "› /subagents" : "› Ask Codex to do anything",
      "  GPT-6.1-Sol medium · ~/projects/hmn-vm · Main [default]",
      "  ← for agents · ? for shortcuts",
    ].join("\n");
  };
  const pane: HarnessSubagentPane = {
    read: async () => view(),
    type: async (text) => {
      typed.push(text);
      if (open) {
        if (text === "\u001b[H") {
          selected = 0;
          top = 0;
        } else if (text === "\u001b[6~") {
          selected = Math.min(rows.length - 1, selected + maxVisible);
          ensureVisible();
        } else if (text === "\u001b[A") {
          selected = Math.max(0, selected - 1);
          ensureVisible();
        } else if (text === "\u001b[B") {
          selected = Math.min(rows.length - 1, selected + 1);
          ensureVisible();
        } else if (text === "\u001b" || text === "\r") {
          open = false;
        }
        return;
      }
      if (text === "/subagents") composer = "/subagents";
      else if (text === "\r" && composer === "/subagents") {
        composer = "";
        open = true;
      }
    },
  };
  return { pane, typed, state: () => ({ open, selected, main: selected === 0 }) };
}

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

  it("switches to a visible child by the id Codex prints", async () => {
    const rows = [MAIN_ROW, childRow(1), childRow(2)];
    const harness = pickerHarness(rows);
    const target = rows[2] as PickerRow;
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents: [], pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.state()).toEqual({ open: false, selected: 2, main: false });
    expect(harness.typed).toEqual(["/subagents", "\r", "\u001b[B", "\u001b[B", "\r"]);
  });

  it("pages past the eight painted rows to reach a child below the fold", async () => {
    const rows = [MAIN_ROW, ...Array.from({ length: 30 }, (_, index) => childRow(index + 1))];
    const harness = pickerHarness(rows);
    const target = rows[20] as PickerRow; // row 21
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents: [], pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.state().selected).toBe(20);
    // The digit shortcut only reaches rows 1-9; this row must be reached by
    // pages and arrows, never by typing its number.
    expect(harness.typed.filter((key) => /^\d+$/.test(key))).toEqual([]);
    expect(harness.typed.filter((key) => key === "\u001b[6~")).toHaveLength(3);
    expect(harness.typed.filter((key) => key === "\u001b[A")).toHaveLength(4);
  });

  it("normalizes a picker a previous attempt left scrolled", async () => {
    const rows = [MAIN_ROW, ...Array.from({ length: 30 }, (_, index) => childRow(index + 1))];
    const harness = pickerHarness(rows, { open: true, selected: 25 });
    const target = rows[20] as PickerRow;
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents: [], pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.typed[0]).toBe("\u001b[H");
    expect(harness.state().selected).toBe(20);
  });

  it("returns to Main when the picker is scrolled away from it", async () => {
    const rows = [MAIN_ROW, ...Array.from({ length: 30 }, (_, index) => childRow(index + 1))];
    const harness = pickerHarness(rows, { open: true, selected: 25 });
    const result = await plugin.subagents?.select?.({ agentId: null, agents: [], pane: harness.pane });
    expect(result).toEqual({ selectedId: null });
    expect(harness.state()).toEqual({ open: false, selected: 0, main: true });
    expect(harness.typed).toEqual(["\u001b[H", "\r"]);
  });

  it("closes a picker it opened when the clicked child is no longer listed", async () => {
    const harness = pickerHarness([MAIN_ROW, childRow(1)]);
    await expect(
      plugin.subagents?.select?.({ agentId: childRow(99).id, agents: [], pane: harness.pane }),
    ).rejects.toThrow("didn't list that subagent");
    expect(harness.typed.at(-1)).toBe("\u001b");
    expect(harness.state().open).toBe(false);
  });

  it("finds a picker row whose id wraps in a narrow pane", async () => {
    const wrap = (id: string) => `${id.slice(0, 18)}\n  ${id.slice(18)}`;
    const rows = [MAIN_ROW, childRow(1), childRow(2)];
    const harness = pickerHarness(rows, { formatId: wrap });
    const target = rows[2] as PickerRow;
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents: [], pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.state().selected).toBe(2);
  });

  it("switches to a child when the picker hides its id column", async () => {
    // Codex hides the description column when the name column leaves under 24
    // columns beside it, which is what a sidebar-width pane does to long task
    // names. Only the row's label identifies the child then.
    const rows = [MAIN_ROW, childRow(1), childRow(2)];
    const harness = pickerHarness(rows, { formatId: () => "" });
    const target = rows[2] as PickerRow;
    const agents = rows.slice(1).map((row) => ({
      id: row.id,
      name: row.name.replace(/^\/root\//, ""),
      status: "running" as const,
      startedAt: 0,
    }));
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents, pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.state()).toEqual({ open: false, selected: 2, main: false });
  });

  it("matches a hidden-id row that Codex marks as the current view", async () => {
    const rows = [MAIN_ROW, childRow(1), childRow(2)];
    const harness = pickerHarness(rows, { open: true, selected: 2, currentRow: 2, formatId: () => "" });
    const target = rows[2] as PickerRow;
    const agents = rows.slice(1).map((row) => ({
      id: row.id,
      name: row.name.replace(/^\/root\//, ""),
      status: "running" as const,
      startedAt: 0,
    }));
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents, pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.typed).toEqual(["\r"]);
  });

  it("doesn't guess a hidden-id row by a name the roster doesn't share", async () => {
    const rows = [MAIN_ROW, childRow(1), childRow(2)];
    const harness = pickerHarness(rows, { formatId: () => "" });
    const target = rows[2] as PickerRow;
    const agents = [{ id: target.id, name: "another_task", status: "running" as const, startedAt: 0 }];
    await expect(plugin.subagents?.select?.({ agentId: target.id, agents, pane: harness.pane })).rejects.toThrow(
      "didn't list that subagent",
    );
  });

  it("matches the row's trailing id, not a uuid inside its label", async () => {
    const labelWithId = `/root/mentions-${MAIN_ROW.id}`;
    const target = childRow(2);
    const harness = pickerHarness([MAIN_ROW, { name: labelWithId, id: target.id }]);
    const result = await plugin.subagents?.select?.({ agentId: target.id, agents: [], pane: harness.pane });
    expect(result).toEqual({ selectedId: target.id });
    expect(harness.state().selected).toBe(1);
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
