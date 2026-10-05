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
    // SSH-SUPPORT.md §1: the visible grouping is "Agent-created" now, and
    // the briefing says so (the old "Cross-agent comms" spelling is gone).
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("Agent-created");
    expect(SUBSHELL_MCP_INSTRUCTIONS).not.toContain("Cross-agent comms");
    // The create tool REPEATS the rule for harnesses that read descriptions
    // without the briefing; that half is asserted on the wire in the
    // tools/list case below.
    expect(SUBSHELL_MCP_INSTRUCTIONS.length).toBeLessThan(1200);
  });

  it("the briefing no longer claims EVERY pane is an agent (SSH-SUPPORT.md §1: SSH panes are agents-optional and gated)", () => {
    expect(SUBSHELL_MCP_INSTRUCTIONS).not.toMatch(/panes on this control plane are agent sessions/);
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("are not agents");
    expect(SUBSHELL_MCP_INSTRUCTIONS).toContain("grant-gated");
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
        // Node-to-node archive transfer (spec 2026-10-01 §6): one tool, copy
        // and diff-sync, the mode a flag not a second verb.
        "transfer_files",
        // The SSH family (SSH-SUPPORT.md §4, Wave 2): six thin passthroughs
        // over the frozen /api/ssh REST surface. No SSH-specific input/log
        // tools: the existing pane tools reach SSH terminals behind policy.
        "list_ssh_connections",
        "execute_ssh_command",
        "read_ssh_command",
        "cancel_ssh_command",
        "open_ssh_terminal",
        "get_terminal_execution",
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
    // The P3 doc fix: the self-restart's OBSERVED shape (no result; the
    // transport closes because this process dies with the pane) is part of
    // the contract agents get, so it is pinned, not just written.
    expect(byName.restart_subshell.description).toContain("never returns a tool result");
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
    // The transfer tool's own boundaries, spec 2026-10-01 §6: the RTT shape
    // of a large call, the human-only remedies for both refusal families,
    // and the rule that the agent never renews its OWN token by self-restart
    // (the same transparency the restart_subshell round established).
    expect(byName.transfer_files.description).toContain("round trips");
    expect(byName.transfer_files.description).toContain("update the node");
    expect(byName.transfer_files.description).toContain("never restart your own pane");
  });

  it("the SSH family carries the frozen arg names and its honesty contract on the wire (SSH-SUPPORT.md §4)", async () => {
    const byName = Object.fromEntries((await listTools()).map((t) => [t.name, t]));
    // Arg names are the frozen MCP block's, snake_case, no invented extras.
    expect(Object.keys(byName.list_ssh_connections.inputSchema.properties ?? {})).toEqual([]);
    expect(Object.keys(byName.execute_ssh_command.inputSchema.properties).sort()).toEqual([
      "command",
      "connection_id",
      "deadline_ms",
      "remote_dir",
    ]);
    expect(Object.keys(byName.read_ssh_command.inputSchema.properties).sort()).toEqual([
      "max_bytes",
      "run_id",
      "stderr_from_byte",
      "stdout_from_byte",
      "wait_ms",
    ]);
    expect(Object.keys(byName.cancel_ssh_command.inputSchema.properties)).toEqual(["run_id"]);
    expect(Object.keys(byName.open_ssh_terminal.inputSchema.properties).sort()).toEqual([
      "cols",
      "connection_id",
      "rows",
    ]);
    expect(Object.keys(byName.get_terminal_execution.inputSchema.properties).sort()).toEqual([
      "execution_id",
      "subshell_id",
    ]);
    // The honesty contract is shipped copy, so it is pinned on the wire:
    // grants-only list, no auto-retry, read-never-cancels, the exit-255
    // caveat, cancellation's unconfirmed remote half, unknown stayed unknown.
    expect(byName.list_ssh_connections.description).toContain("GRANTED");
    expect(byName.execute_ssh_command.description).toContain("auto-retried");
    expect(byName.read_ssh_command.description).toContain("NEVER cancels");
    expect(byName.read_ssh_command.description).toContain("255");
    expect(byName.cancel_ssh_command.description).toContain("UNCONFIRMED");
    expect(byName.open_ssh_terminal.description).toContain("quota_terminals");
    expect(byName.get_terminal_execution.description).toContain("never renamed");
    // No bounds the server also holds (the exec-tool precedent): the numeric
    // args carry only zod's safe-integer sentinel as their bound, i.e. the
    // schema refuses nothing the REST clamp would not itself decide.
    const deadline = JSON.stringify(
      (byName.execute_ssh_command.inputSchema.properties as Record<string, unknown>).deadline_ms,
    );
    expect(deadline).toContain('"maximum":9007199254740991');
    expect(deadline).not.toContain('"maximum":3600000');
    const waitMs = JSON.stringify((byName.read_ssh_command.inputSchema.properties as Record<string, unknown>).wait_ms);
    expect(waitMs).toContain('"maximum":9007199254740991');
    expect(waitMs).not.toContain('"maximum":30000');
  });
});
