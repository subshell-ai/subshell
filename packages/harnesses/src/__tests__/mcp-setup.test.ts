import { describe, expect, it } from "bun:test";
import { ClaudeCodePlugin } from "../claude-code.js";
import { HermesPlugin } from "../hermes.js";
import { OpencodePlugin } from "../opencode.js";
import { PiPlugin } from "../pi.js";
import type { McpLaunchSpec } from "../types.js";

/**
 * Per-harness MCP registration contract (the mechanism behind subshell's
 * cross-session comms): auto harnesses render a per-session config file in
 * their native dialect; manual harnesses expose copy-paste one-time steps.
 */

const launch: McpLaunchSpec = { command: "/opt/subshell/subshell-mcp", args: [] };
const bunLaunch: McpLaunchSpec = { command: "/usr/bin/bun", args: ["/opt/subshell/dist/mcp/main.js"] };

describe("ClaudeCodePlugin MCP registration", () => {
  it("renders the claude mcpServers document and its own activating argv", () => {
    const reg = new ClaudeCodePlugin().mcpRegistration?.(launch, "/data/sess.json");
    expect(reg?.env).toBeUndefined();
    const doc = JSON.parse(reg?.fileContent ?? "{}") as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(doc.mcpServers.subshell).toEqual({ command: "/opt/subshell/subshell-mcp", args: [] });
    // Self-activating: the registration carries the flag, buildCommand only splices.
    expect(reg?.args).toEqual(["--mcp-config", "/data/sess.json"]);
  });
  it("reports auto setup", () => {
    expect(new ClaudeCodePlugin().mcpSetup(launch).mode).toBe("auto");
  });
});

describe("OpencodePlugin MCP registration", () => {
  it("renders the opencode mcp dialect and points OPENCODE_CONFIG at the file", () => {
    const reg = new OpencodePlugin().mcpRegistration?.(bunLaunch, "/data/sess.json");
    expect(reg?.env).toEqual({ OPENCODE_CONFIG: "/data/sess.json" });
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
    const reg = new OpencodePlugin().mcpRegistration?.(launch, "/x.json");
    expect(reg?.fileContent).not.toMatch(/KEY|TOKEN/);
  });
  it("reports auto setup", () => {
    expect(new OpencodePlugin().mcpSetup(launch).mode).toBe("auto");
  });
});

describe("HermesPlugin manual MCP setup", () => {
  it("emits a non-interactive hermes mcp add command with --args last", () => {
    const info = new HermesPlugin().mcpSetup(bunLaunch);
    if (info.mode !== "manual") throw new Error("hermes must be manual");
    expect(info.steps[0].command).toBe(
      "hermes mcp add subshell --command '/usr/bin/bun' --args '/opt/subshell/dist/mcp/main.js'",
    );
    expect(info.steps[1].command).toBe("hermes mcp remove subshell");
  });
  it("omits --args entirely for an arg-less launch", () => {
    const info = new HermesPlugin().mcpSetup(launch);
    if (info.mode !== "manual") throw new Error("hermes must be manual");
    expect(info.steps[0].command).toBe("hermes mcp add subshell --command '/opt/subshell/subshell-mcp'");
    expect(info.steps[0].command).not.toContain("--args");
  });
});

describe("PiPlugin manual MCP setup", () => {
  it("emits the adapter install + the mcpServers snippet the adapter reads", () => {
    const info = new PiPlugin().mcpSetup(bunLaunch);
    if (info.mode !== "manual") throw new Error("pi must be manual");
    expect(info.steps[0].command).toBe("pi install npm:pi-mcp-adapter");
    const snippet = JSON.parse(info.steps[1].command) as { mcpServers: Record<string, unknown> };
    expect(snippet.mcpServers.subshell).toEqual({ command: "/usr/bin/bun", args: ["/opt/subshell/dist/mcp/main.js"] });
  });
});
