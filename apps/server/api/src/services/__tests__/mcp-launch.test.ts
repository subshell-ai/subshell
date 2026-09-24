import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { getHarness } from "@internal/pane-runtime";
import { planRemoteSubshellMcp, registerSubshellMcp, subshellMcpConfigPath } from "@/services/mcp-launch.js";

/**
 * The registration half of `subshell mcp` launch wiring — the pieces the
 * subshell tests stub around rather than exercise. (The resolver ladder moved
 * to `mcp-resolve.ts`, pinned in `mcp-resolve.test.ts`.)
 */

/** `getHarness` answers undefined for an id this build does not carry. */
function harness(id: string) {
  const plugin = getHarness(id);
  if (!plugin) throw new Error(`harness ${id} missing`);
  return plugin;
}

describe("registerSubshellMcp", () => {
  it("auto harness: writes the file (0600) and returns the registration", () => {
    const id = `launch-test-${crypto.randomUUID()}`;
    const reg = registerSubshellMcp(harness("claude-code"), id);
    expect(reg?.args).toEqual(["--mcp-config", expect.stringContaining("/mcp/")]);
    expect(JSON.parse(reg?.fileContent ?? "{}").mcpServers.subshell).toBeTruthy();
    unlinkSync(subshellMcpConfigPath(id)); // throwaway dir, but leave no litter
  });

  it("manual harness: returns undefined and writes nothing to register", () => {
    // hermes has no mcpRegistration — the subshell launch carries no MCP wiring
    // beyond SUBSHELL_* (asserted end-to-end in subshell-manager-mcp.test.ts).
    expect(registerSubshellMcp(harness("hermes"), "launch-test-hermes")).toBeUndefined();
  });
});

describe("planRemoteSubshellMcp", () => {
  // The Critical chain (final review R14a): the node writes the registration
  // fileContent VERBATIM (launch.ts, no recompute), so the command+args
  // composed HERE are the only thing the pane will ever spawn. An agent's
  // `selfInvoke` (ready frame, `selfInvocation`) is the sole authority on what
  // starts `subshell mcp` on that machine — a bare `process.execPath` gave
  // every dev-run agent's panes a `bun mcp` that cannot start.

  it("composes from the agent's selfInvoke verbatim, interpreter shape included", () => {
    const plan = planRemoteSubshellMcp(harness("claude-code"), "a2000000-0000-4000-8000-000000000002", {
      dataDir: "/d",
      selfInvoke: { command: "/usr/local/bin/bun", args: ["/opt/subshell/src/index.ts"] },
    });
    expect(plan).toBeDefined();
    if (!plan) throw new Error("remote mcp plan missing");
    // The dialect embeds the command as one string (claude: `command` +
    // `args` in the JSON) — both halves must be the AGENT's answer.
    const content = JSON.parse(plan.reg.fileContent) as {
      mcpServers: { subshell: { command: string; args: string[] } };
    };
    expect(content.mcpServers.subshell.command).toBe("/usr/local/bin/bun");
    expect(content.mcpServers.subshell.args).toEqual(["/opt/subshell/src/index.ts", "mcp"]);
  });

  it("absent selfInvoke falls back to `subshell` mcp on PATH, as before", () => {
    const plan = planRemoteSubshellMcp(harness("claude-code"), "a3000000-0000-4000-8000-000000000003", {
      dataDir: "/d",
    });
    if (!plan) throw new Error("remote mcp plan missing");
    const content = JSON.parse(plan.reg.fileContent) as {
      mcpServers: { subshell: { command: string; args: string[] } };
    };
    expect(content.mcpServers.subshell.command).toBe("subshell");
    expect(content.mcpServers.subshell.args).toEqual(["mcp"]);
  });

  it("the composed args are a copy — later fact refreshes cannot mutate a shipped plan", () => {
    const selfInvoke = { command: "/usr/bin/subshell", args: [] as string[] };
    const plan = planRemoteSubshellMcp(harness("claude-code"), "a4000000-0000-4000-8000-000000000004", {
      dataDir: "/d",
      selfInvoke,
    });
    if (!plan) throw new Error("remote mcp plan missing");
    selfInvoke.args = ["poisoned"];
    const content = JSON.parse(plan.reg.fileContent) as { mcpServers: { subshell: { args: string[] } } };
    expect(content.mcpServers.subshell.args).toEqual(["mcp"]);
  });

  it("target path is the node-side layout, unchanged by the composition change", () => {
    const plan = planRemoteSubshellMcp(harness("claude-code"), "a5000000-0000-4000-8000-000000000005", {
      dataDir: "/node/d",
    });
    if (!plan) throw new Error("remote mcp plan missing");
    expect(plan.configPath).toBe("/node/d/mcp/a5000000-0000-4000-8000-000000000005.json");
  });
});
