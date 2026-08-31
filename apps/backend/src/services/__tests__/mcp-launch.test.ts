import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { ClaudeCodePlugin, HermesPlugin } from "@internal/harnesses";
import {
  MCP_LAUNCH_PLACEHOLDER,
  registerSessionMcp,
  resolveMcpLaunch,
  resolveMcpLaunchForDisplay,
  sessionMcpConfigPath,
} from "@/services/mcp-launch.js";

/**
 * The resolver + registration half of `mote mcp` launch wiring — the pieces
 * the session tests stub around rather than exercise.
 */
describe("resolveMcpLaunch", () => {
  it("honors MOTE_MCP_COMMAND + MOTE_MCP_ARGS above all autodetection", () => {
    const launch = resolveMcpLaunch({ MOTE_MCP_COMMAND: "/opt/custom/mcp", MOTE_MCP_ARGS: '["a","b"]' });
    expect(launch).toEqual({ command: "/opt/custom/mcp", args: ["a", "b"] });
  });

  it("MOTE_MCP_COMMAND alone means an empty argv", () => {
    expect(resolveMcpLaunch({ MOTE_MCP_COMMAND: "/opt/custom/mcp" })).toEqual({
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
    // (`mote-mcp`, via bun run compile). An invented `mote mcp` subcommand once
    // shipped here and would have poisoned every operator's manual registration.
    expect(resolveMcpLaunchForDisplay()).toBeDefined();
    expect(MCP_LAUNCH_PLACEHOLDER).toEqual({ command: "mote-mcp", args: [] });
  });
});

describe("registerSessionMcp", () => {
  it("auto harness: writes the file (0600) and returns the registration", () => {
    const id = `launch-test-${crypto.randomUUID()}`;
    const reg = registerSessionMcp(new ClaudeCodePlugin(), id);
    expect(reg?.args).toEqual(["--mcp-config", expect.stringContaining("/mcp/")]);
    expect(JSON.parse(reg?.fileContent ?? "{}").mcpServers.mote).toBeTruthy();
    unlinkSync(sessionMcpConfigPath(id)); // throwaway dir, but leave no litter
  });

  it("manual harness: returns undefined and writes nothing to register", () => {
    // hermes has no mcpRegistration — the session launch carries no MCP wiring
    // beyond MOTE_* (asserted end-to-end in session-manager-mcp.test.ts).
    expect(registerSessionMcp(new HermesPlugin(), "launch-test-hermes")).toBeUndefined();
  });
});
