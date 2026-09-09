import { describe, expect, it } from "bun:test";
import { unlinkSync } from "node:fs";
import { getHarness, HermesPlugin } from "@internal/pane-runtime";
import { registerSubshellMcp, subshellMcpConfigPath } from "@/services/mcp-launch.js";

/**
 * The registration half of `subshell mcp` launch wiring — the pieces the
 * subshell tests stub around rather than exercise. (The resolver ladder moved
 * to `mcp-resolve.ts`, pinned in `mcp-resolve.test.ts`.)
 */

describe("registerSubshellMcp", () => {
  it("auto harness: writes the file (0600) and returns the registration", () => {
    const id = `launch-test-${crypto.randomUUID()}`;
    const reg = registerSubshellMcp(getHarness("claude-code")!, id);
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
