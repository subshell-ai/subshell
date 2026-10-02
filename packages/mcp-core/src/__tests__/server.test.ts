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

  it("the briefing gained the machines line (spec 2026-09-25) and is still short", () => {
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("list_nodes");
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("working_dir");
    expect(SUBSHELL_MCP_INSTRUCTIONS.length).toBeLessThan(1200);
  });

  it("the briefing owns the spawned-pane cleanup rule (2026-09-25: comms panes the human never hears about)", () => {
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("yours to close");
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("Cross-agent comms");
    // The create tool REPEATS the rule for harnesses that read descriptions
    // without the briefing; that half is asserted on the wire in the
    // tools/list case below.
    expect(SUBSHELL_MCP_INSTRUCTIONS.length).toBeLessThan(1200);
  });
});

/**
 * Drives a real McpServer over the in-memory transport through the handshake
 * and one `tools/list`, returning the declared tool surface: the registration
 * list IS the product an agent sees, so it is asserted on the wire, not on
 * the source text.
 */
async function listTools(): Promise<{ name: string; description: string; inputSchema: Record<string, any> }[]> {
  const server = createSubshellMcpServer({ api, own });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const responses = new Map<number, Record<string, any>>();
  const waiters = new Map<number, (v: Record<string, any>) => void>();
  clientSide.onmessage = (msg: any) => {
    if (typeof msg?.id === "number") {
      responses.set(msg.id, msg);
      waiters.get(msg.id)?.(msg);
    }
  };
  await server.connect(serverSide);
  await clientSide.start();
  const awaitId = (id: number) => responses.get(id) ?? new Promise((r) => waiters.set(id, r));
  await clientSide.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  } as never);
  await awaitId(1);
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
  await clientSide.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } as never);
  const res = (await awaitId(2)) as { result: { tools: never[] } };
  return res.result.tools;
}

describe("subshell mcp tool surface (tools/list, spec 2026-09-25)", () => {
  it("gains the machine and pane moves, loses channel_members", async () => {
    const names = (await listTools()).map((t) => t.name);
    expect(names).not.toContain("channel_members");
    expect(new Set(names)).toEqual(
      new Set([
        "list_channels",
        "create_channel",
        "join_channel",
        "post_channel",
        "read_channel",
        "list_subshells",
        "get_subshell",
        "list_presets",
        "create_subshell",
        "restart_subshell",
        "terminate_subshell",
        "delete_subshell",
        "list_nodes",
        "read_subshell_log",
        "send_to_subshell",
        // The terminal family (spec 2026-10-02): one command in a shell pane,
        // sentinel-answered.
        "exec_in_terminal",
        // The saved-prompt library, five tools (spec 2026-09-28): a pane may
        // full-CRUD its owner's prompts, the share flip included.
        "list_prompts",
        "get_prompt",
        "create_prompt",
        "update_prompt",
        "delete_prompt",
      ]),
    );
  });

  it("the schemas and descriptions carry the new addressing and steering surface", async () => {
    const byName = Object.fromEntries((await listTools()).map((t) => [t.name, t]));
    const createProps = byName.create_subshell.inputSchema.properties as Record<string, unknown>;
    expect(createProps).toHaveProperty("node");
    expect(JSON.stringify(createProps.working_dir)).toContain("TARGET NODE");
    // Launching is FROM a preset by default (spec 2026-09-29 ruling) since
    // spec 2026-10-01 §1 has ONE deliberate exception: a presetless launch of
    // a terminal-type harness. So no key is schema-required any more (the
    // preset-or-harness rule is a refine + the handler's type gate), the
    // prompt relationship stays an explicit enum, and the cursor reads join
    // the read tool.
    expect(((byName.create_subshell.inputSchema.required as string[] | undefined) ?? []).sort()).toEqual([]);
    expect(JSON.stringify(createProps.harness)).toContain("terminal");
    expect(createProps).toHaveProperty("prompt_mode");
    expect(JSON.stringify(createProps.prompt_mode)).toContain("append");
    expect(byName.create_subshell.description).toContain("PRESETLESS");
    expect(byName.create_subshell.description).toContain("agent harnesses always launch from a preset");
    expect(byName.create_subshell.description).toContain("list_subshells before retrying");
    expect(byName.create_subshell.description).toContain("You own their cleanup");
    expect(byName.send_to_subshell.description).toContain("SUBSHELL_NOT_RUNNING");
    // The exec tool's shell-contract honesty rides its OWN description, not
    // the briefing (spec 2026-10-02: SUBSHELL_MCP_INSTRUCTIONS stays untouched).
    expect(byName.exec_in_terminal.description).toContain("POSIX");
    expect(byName.exec_in_terminal.description).toContain("timed_out");
    expect(Object.keys(byName.exec_in_terminal.inputSchema.properties).sort()).toEqual([
      "command",
      "subshell_id",
      "timeout_ms",
    ]);
    expect(Object.keys(byName.get_subshell.inputSchema.properties).sort()).toEqual(["id", "name"]);
    expect(byName.get_subshell.description).toContain("name");
    expect(byName.restart_subshell.inputSchema.properties).toHaveProperty("prompt");
    expect(byName.restart_subshell.description).toContain("OWN subshell terminates you");
    expect(byName.terminate_subshell.description).toContain("row and history stay");
    expect(byName.delete_subshell.description).toContain("owner-only");
    expect(byName.list_nodes.description).toContain("inventoryStale");
    expect(byName.send_to_subshell.description).toContain("untrusted");
    expect(byName.read_subshell_log.description).toContain("ANSI-stripped");
    // The byte cursor (spec 2026-10-01 §3): taught on the wire, and honest
    // about the loop's contract.
    expect(Object.keys(byName.read_subshell_log.inputSchema.properties).sort()).toEqual(["from_byte", "id", "limit"]);
    expect(byName.read_subshell_log.description).toContain("nextByte");
    expect(byName.list_presets.description).toContain("a plain terminal harness can");
    expect(byName.list_presets.description).toContain("catalogOnly");
    expect(byName.list_presets.description).toContain("address them by id");
    expect(JSON.stringify(byName.create_subshell.inputSchema.properties.preset)).toContain("Preset ID");
    // The prompt tools name the sharing consequence in their own description
    // (the disclosure is the agent-visible decision).
    expect(byName.create_prompt.description).toContain("shared");
    expect(byName.list_prompts.description).toContain("shared");
  });
});
