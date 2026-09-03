import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { ClaudeCodePlugin, HermesPlugin } from "@internal/harnesses";
import {
  MCP_LAUNCH_PLACEHOLDER,
  registerSubshellMcp,
  resolveMcpLaunch,
  resolveMcpLaunchForDisplay,
  subshellMcpConfigPath,
} from "@/services/mcp-launch.js";

/**
 * The resolver + registration half of `subshell mcp` launch wiring — the pieces
 * the subshell tests stub around rather than exercise.
 */
describe("resolveMcpLaunch", () => {
  it("honors SUBSHELL_MCP_COMMAND + SUBSHELL_MCP_ARGS above all autodetection", () => {
    const launch = resolveMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp", SUBSHELL_MCP_ARGS: '["a","b"]' });
    expect(launch).toEqual({ command: "/opt/custom/mcp", args: ["a", "b"] });
  });

  it("SUBSHELL_MCP_COMMAND alone means an empty argv", () => {
    expect(resolveMcpLaunch({ SUBSHELL_MCP_COMMAND: "/opt/custom/mcp" })).toEqual({
      command: "/opt/custom/mcp",
      args: [],
    });
  });
});

describe("resolveMcpLaunchForDisplay", () => {
  it("never throws; the unresolved-fallback constant names a real artifact", () => {
    // In-repo autodetection always succeeds, so this exercises the happy path;
    // the real assertion pins the fallback CONSTANT (the catch branch's value,
    // unforceable from tests): it must name something this repo actually ships
    // (`subshell-mcp`, via bun run compile). An invented `subshell mcp` subcommand once
    // shipped here and would have poisoned every operator's manual registration.
    expect(resolveMcpLaunchForDisplay()).toBeDefined();
    expect(MCP_LAUNCH_PLACEHOLDER).toEqual({ command: "subshell-mcp", args: [] });
  });
});

describe("registerSubshellMcp", () => {
  it("auto harness: writes the file (0600) and returns the registration", () => {
    const id = `launch-test-${crypto.randomUUID()}`;
    const reg = registerSubshellMcp(new ClaudeCodePlugin(), id);
    expect(reg?.args).toEqual(["--mcp-config", expect.stringContaining("/mcp/")]);
    expect(JSON.parse(reg?.fileContent ?? "{}").mcpServers.subshell).toBeTruthy();
    unlinkSync(subshellMcpConfigPath(id)); // throwaway dir, but leave no litter
  });

  it("manual harness: returns undefined and writes nothing to register", () => {
    // hermes has no mcpRegistration — the subshell launch carries no MCP wiring
    // beyond SUBSHELL_* (asserted end-to-end in subshell-manager-mcp.test.ts).
    expect(registerSubshellMcp(new HermesPlugin(), "launch-test-hermes")).toBeUndefined();
  });
});
