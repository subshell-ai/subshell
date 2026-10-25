import { describe, expect, it } from "bun:test";
import { getHarness } from "../index.js";
import type { McpLaunchSpec } from "../types.js";

/**
 * Per-harness MCP registration contract (the mechanism behind subshell's
 * cross-subshell comms): auto harnesses render a per-subshell config file in
 * their native dialect; manual harnesses expose copy-paste one-time steps.
 */

const launch: McpLaunchSpec = { command: "/opt/subshell/subshell-mcp", args: [] };
const bunLaunch: McpLaunchSpec = { command: "/usr/bin/bun", args: ["/opt/subshell/dist/mcp/main.js"] };

describe("ClaudeCodePlugin MCP registration", () => {
  it("renders the claude mcpServers document and its own activating argv", () => {
    const harness = getHarness("claude-code");
    if (harness === undefined) throw new Error("the claude-code harness is not registered");
    const reg = harness.mcpRegistration?.(launch, "/data/sess.json");
    expect(reg?.env).toBeUndefined();
    const doc = JSON.parse(reg?.fileContent ?? "{}") as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(doc.mcpServers.subshell).toEqual({ command: "/opt/subshell/subshell-mcp", args: [] });
    // Self-activating: the registration carries the flag, buildCommand only splices.
    expect(reg?.args).toEqual(["--mcp-config", "/data/sess.json"]);
  });
  it("reports auto setup", () => {
    expect(getHarness("claude-code")!.mcpSetup(launch).mode).toBe("auto");
  });
});

describe("OpencodePlugin MCP registration", () => {
  it("renders the opencode mcp dialect and points OPENCODE_CONFIG at the file", () => {
    const reg = getHarness("opencode")!.mcpRegistration?.(bunLaunch, "/data/sess.json");
    expect(reg?.env).toEqual({ OPENCODE_CONFIG: "/data/sess.json", OPENCODE_TUI_CONFIG: "/data/sess.json.d/tui.json" });
    const doc = JSON.parse(reg?.fileContent ?? "{}") as {
      mcp: { subshell: { type: string; command: string[]; enabled: boolean } };
    };
    // command is the full argv ARRAY (opencode's local-server shape) —
    // verified against opencode 1.18.18 `mcp list` deep-merge behaviour.
    expect(doc.mcp.subshell).toEqual({
      type: "local",
      command: ["/usr/bin/bun", "/opt/subshell/dist/mcp/main.js"],
      enabled: true,
    });
  });
  it("carries no secrets in the generated file", () => {
    const reg = getHarness("opencode")!.mcpRegistration?.(launch, "/x.json");
    expect(reg?.fileContent).not.toMatch(/KEY|TOKEN/);
  });
  it("reports auto setup", () => {
    expect(getHarness("opencode")!.mcpSetup(launch).mode).toBe("auto");
  });
});

describe("CodexPlugin MCP registration", () => {
  it("renders per-invocation -c config overrides (TOML values) and no wiring env", () => {
    const reg = getHarness("codex")!.mcpRegistration?.(bunLaunch, "/data/sess.json");
    // The -c argv IS the wiring: codex reads ~/.codex/config.toml under
    // CODEX_HOME (the user's auth.json lives there), and subshell never touches
    // it — so no env is returned and the user's own servers are untouched.
    expect(reg?.env).toBeUndefined();
    expect(reg?.args).toEqual([
      "-c",
      'mcp_servers.subshell.command="/usr/bin/bun"',
      "-c",
      'mcp_servers.subshell.args=["/opt/subshell/dist/mcp/main.js"]',
      "-c",
      'mcp_servers.subshell.env_vars=["SUBSHELL_API_KEY", "SUBSHELL_BASE_URL", "SUBSHELL_ID", "SUBSHELL_NAME", "SUBSHELL_DATA_DIR", "SUBSHELL_SERVER_DATA_DIR"]',
    ]);
    // The written file is a manual-setup reference only — its shape is the
    // exact [mcp_servers.NAME] block codex's config.toml expects.
    expect(reg?.fileContent).toContain("[mcp_servers.subshell]");
    expect(reg?.fileContent).toContain('command = "/usr/bin/bun"');
  });
  it("carries no secrets in the generated file", () => {
    const reg = getHarness("codex")!.mcpRegistration?.(launch, "/x.json");
    // env_vars forwards NAMEs (SUBSHELL_API_KEY and friends), never values,
    // so a blanket /KEY|TOKEN/ scan trips on legitimate forwarding. Assert
    // the real contract: the block carries names only, and no wiring env map.
    const doc = Bun.TOML.parse(reg?.fileContent ?? "") as {
      mcp_servers: { subshell: Record<string, unknown> };
    };
    const block = doc.mcp_servers.subshell;
    expect(block.env).toBeUndefined();
    const names = block.env_vars as string[];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^SUBSHELL_[A-Z_]+$/);
  });
  it("reports auto setup", () => {
    expect(getHarness("codex")!.mcpSetup(launch).mode).toBe("auto");
  });
});

describe("HermesPlugin manual MCP setup", () => {
  it("emits a non-interactive hermes mcp add command with --args last", () => {
    const info = getHarness("hermes")!.mcpSetup(bunLaunch);
    if (info.mode !== "manual") throw new Error("hermes must be manual");
    expect(info.steps[0].command).toBe(
      "hermes mcp add subshell --command '/usr/bin/bun' --args '/opt/subshell/dist/mcp/main.js'",
    );
    expect(info.steps[1].command).toBe("hermes mcp remove subshell");
  });
  it("omits --args entirely for an arg-less launch", () => {
    const info = getHarness("hermes")!.mcpSetup(launch);
    if (info.mode !== "manual") throw new Error("hermes must be manual");
    expect(info.steps[0].command).toBe("hermes mcp add subshell --command '/opt/subshell/subshell-mcp'");
    expect(info.steps[0].command).not.toContain("--args");
  });
});

describe("PiPlugin manual MCP setup", () => {
  it("emits the adapter install + the mcpServers snippet the adapter reads", () => {
    const info = getHarness("pi")!.mcpSetup(bunLaunch);
    if (info.mode !== "manual") throw new Error("pi must be manual");
    expect(info.steps[0].command).toBe("pi install npm:pi-mcp-adapter");
    const snippet = JSON.parse(info.steps[1].command) as { mcpServers: Record<string, unknown> };
    expect(snippet.mcpServers.subshell).toEqual({ command: "/usr/bin/bun", args: ["/opt/subshell/dist/mcp/main.js"] });
  });
});
