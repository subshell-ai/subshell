import { describe, expect, it } from "bun:test";
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import type { IdentityKeyPair } from "../crypto.js";
import { createSubshellMcpServer, SUBSHELL_MCP_INSTRUCTIONS } from "../server.js";
import type { ToolApi } from "../tools.js";

/**
 * `initialize.instructions` is the only surface every conforming harness
 * sees at connect time; these pin that it carries the cross-session briefing
 * (the 2026-09-03 keep-panes session proved agents guess via git without it).
 */

const api: ToolApi = {
  async req<T>(): Promise<T> {
    return {} as T;
  },
};
const own: IdentityKeyPair = { principalId: "sess:test", publicJwk: "{}", privateJwk: "{}" };

describe("subshell mcp instructions", () => {
  it("the initialize handshake carries the instructions verbatim", async () => {
    const server = createSubshellMcpServer({ api, own });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const answered = new Promise<Record<string, any>>((resolve) => {
      clientSide.onmessage = (msg: any) => {
        if (msg.id === 1) resolve(msg);
      };
    });
    await server.connect(serverSide);
    await clientSide.start();
    await clientSide.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    });
    const res = await answered;
    expect(res.result?.instructions).toBe(SUBSHELL_MCP_INSTRUCTIONS);
  });

  it("the briefing names the three moves an agent needs: status, channels, pull-delivery", () => {
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("list_subshells");
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("get_subshell");
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("read_channel");
    // Pull delivery is the fact agents get wrong without being told: a post
    // is invisible until the peer reads.
    expect(SUBSHELL_MCP_INSTRUCTIONS.toLowerCase()).toContain("pull");
    // Brevity is part of the contract — this string enters every pane's
    // context on connect; a wall of instructions teaches nothing.
    expect(SUBSHELL_MCP_INSTRUCTIONS.length).toBeLessThan(1200);
  });
});
