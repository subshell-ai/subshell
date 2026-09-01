import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HarnessPlugin, McpRegistration, ProfileDefinition } from "@internal/harnesses";
import type { NodeCommandBody, NodeEvent } from "@internal/session-protocol";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { launcherFor, resetLauncherRegistryForTests } from "@/services/nodes/launcher-registry.js";
import { defaultLocalLauncher } from "@/services/nodes/local-launcher.js";
import { dispatchOutput, resetNodeEventsForTests } from "@/services/nodes/node-events.js";
import type { NodeAgentFacts } from "@/services/nodes/node-registry.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";
import { NoLiveConnectionError, RemoteLauncher } from "@/services/nodes/remote-launcher.js";

/**
 * RemoteLauncher — the command-mapping table of spec §6.3 pinned call by
 * call: exact wire objects (`toEqual` on the seam), per-command timeouts, the
 * swallow/rethrow error classes, the facts short-circuit, and the tail relay
 * (gap backfill / dup clamp / ordering) driven through the REAL output bus
 * with manual `dispatchOutput` calls.
 */

/** One recorded seam call. */
interface Sent {
  cmd: NodeCommandBody;
  timeoutMs: number;
}

type OutputEvent = Extract<NodeEvent, { type: "output" }>;

/** Scripted answer: a value, or a thunk that may throw (sync ⇒ rejected promise). */
type Script = unknown | (() => unknown);

function makeHarness(facts: NodeAgentFacts | null = testFacts) {
  const calls: Sent[] = [];
  const scripts = new Map<string, Script[]>();
  // `null` (not `undefined`) means offline — an explicit `undefined` would
  // re-trigger the default-parameter above.
  let currentFacts: NodeAgentFacts | undefined = facts ?? undefined;
  let row: NodeTable | undefined;

  const send = async (_nodeId: string, cmd: NodeCommandBody, timeoutMs = 10_000): Promise<unknown> => {
    calls.push({ cmd, timeoutMs });
    const queue = scripts.get(cmd.type);
    const script = queue?.shift();
    if (script === undefined) return undefined;
    return typeof script === "function" ? (script as () => unknown)() : script;
  };

  const launcher = new RemoteLauncher("node-1", {
    send,
    nodes: { findById: async () => row },
    facts: () => currentFacts,
  });

  return {
    launcher,
    calls,
    /** Queue one answer for the next command of `type` (functions may throw/return promises). */
    answer(type: string, script: Script) {
      const q = scripts.get(type) ?? [];
      q.push(script);
      scripts.set(type, q);
    },
    setFacts(f: NodeAgentFacts | undefined) {
      currentFacts = f;
    },
    setRow(r: NodeTable | undefined) {
      row = r;
    },
  };
}

const testFacts: NodeAgentFacts = {
  dataDir: "/home/u/.mote-agent",
  capabilities: ["mcp", "uploads"],
  hostname: "box",
  agentVersion: "0.2.0",
  executablePath: "/usr/bin/mote-agent",
};

const harness = { id: "claude-code" } as unknown as HarnessPlugin;

/**
 * writeArtifact uuid-gates the id (mirrors the agent's isSessionId), so its
 * tests use a uuid-ish session id; everything else keeps the short "s1".
 */
const UUID = "0e63c9a1-2f5b-4c8a-9d1e-2f3a4b5c6d7e";
const artifactPath = `/home/u/.mote-agent/mcp/${UUID}.json`;

const testProfile: ProfileDefinition = {
  name: "p",
  env: {},
  flags: [],
  settings: null,
  configIsolation: false,
};

function nodeRow(over: Partial<NodeTable> = {}): NodeTable {
  return {
    id: "node-1",
    ownerUserId: "u1",
    name: "box",
    kind: "agent",
    os: null,
    arch: null,
    hostname: null,
    status: "online",
    lastSeenAt: null,
    agentVersion: null,
    protocolVersion: null,
    publicKey: null,
    apiKeyId: null,
    capabilities: null,
    inventoryJson: null,
    inventoryAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function inventoryRow(at: string): NodeTable {
  return nodeRow({
    inventoryJson: JSON.stringify([
      { harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude", version: "1.2.3" },
      { harnessId: "opencode", installed: false },
    ]),
    inventoryAt: at,
  });
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Drain the microtask/tail queue chain enough for scripted relays to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Bun.sleep(0);
}

function outputEvent(over: Partial<OutputEvent> & { sessionId: string; subId: string }): OutputEvent {
  return { type: "output", fromByte: 0, toByte: 0, data_b64: "", ...over };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected rejection, got fulfilment");
    },
    (err: unknown) => err,
  );
}

beforeEach(() => resetNodeEventsForTests());
afterEach(() => {
  resetNodeEventsForTests();
  resetLauncherRegistryForTests();
});

describe("validateWorkingDir", () => {
  it("sends stat_dir (5 s) and returns the AGENT's realpath", async () => {
    const h = makeHarness();
    h.answer("stat_dir", { path: "/x/real", isDirectory: true });
    expect(await h.launcher.validateWorkingDir("/x/")).toBe("/x/real");
    expect(h.calls).toEqual([{ cmd: { type: "stat_dir", path: "/x/" }, timeoutMs: 5_000 }]);
  });

  it("maps a failed stat_dir to a PLAIN Error (LocalLauncher throw shape)", async () => {
    const h = makeHarness();
    h.answer("stat_dir", () => {
      throw new NodeRpcError("failed", 'node "node-1" reported: ENOENT: /nope', "node-1");
    });
    const err = (await rejection(h.launcher.validateWorkingDir("/nope"))) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NodeRpcError);
    expect(err.message).toBe('node "node-1" reported: ENOENT: /nope');
  });

  it("keeps offline/timeout NodeRpcErrors as they are", async () => {
    const h = makeHarness();
    h.answer("stat_dir", () => {
      throw new NodeRpcError("offline", 'node "node-1" has no live connection', "node-1");
    });
    const err = (await rejection(h.launcher.validateWorkingDir("/x"))) as NodeRpcError;
    expect(err).toBeInstanceOf(NodeRpcError);
    expect(err.code).toBe("offline");
  });

  it("rejects a malformed ok:true payload", async () => {
    const h = makeHarness();
    h.answer("stat_dir", { path: 1, isDirectory: true });
    expect(((await rejection(h.launcher.validateWorkingDir("/x"))) as Error).message).toContain("malformed stat_dir");
  });
});

describe("resolveBinary", () => {
  it("answers from a fresh cached inventory with NO network", async () => {
    const h = makeHarness();
    h.setRow(inventoryRow(new Date().toISOString()));
    expect(await h.launcher.resolveBinary(harness)).toBe("/usr/bin/claude");
    expect(h.calls).toEqual([]);
  });

  it("null for a missing entry, a missing harness path, or a missing node row", async () => {
    const h = makeHarness();
    h.setRow(inventoryRow(new Date().toISOString()));
    expect(await h.launcher.resolveBinary({ id: "hermes" } as unknown as HarnessPlugin)).toBeNull();
    expect(await h.launcher.resolveBinary(harness)).toBe("/usr/bin/claude"); // re-read, cache only
    h.setRow(undefined);
    expect(await h.launcher.resolveBinary(harness)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("a stale snapshot still answers from cache and fires the refresh UNAWAITED", async () => {
    const h = makeHarness();
    h.setRow(inventoryRow("2020-01-01T00:00:00.000Z"));
    // A never-resolving inventory command: if the refresh were awaited this test would hang.
    h.answer("inventory", () => new Promise(() => {}));
    expect(await h.launcher.resolveBinary(harness)).toBe("/usr/bin/claude");
    expect(h.calls).toEqual([{ cmd: { type: "inventory" }, timeoutMs: 10_000 }]);
  });

  it("a failing fire-and-forget refresh never rejects resolveBinary", async () => {
    const h = makeHarness();
    h.setRow(inventoryRow("2020-01-01T00:00:00.000Z"));
    h.answer("inventory", () => {
      throw new NodeRpcError("offline", 'node "node-1" has no live connection', "node-1");
    });
    expect(await h.launcher.resolveBinary(harness)).toBe("/usr/bin/claude");
    await flush();
  });
});

describe("launch", () => {
  const planBase = () => ({
    id: "s1",
    socket: "mote-abc",
    harness,
    binary: "/usr/bin/claude",
    cwd: "/work",
    profile: testProfile,
    sessionName: "s1",
    moteEnv: { MOTE_SESSION_ID: "s1" },
  });

  it("maps the plan to the launch command (60 s), no mcp when absent", async () => {
    const h = makeHarness();
    await h.launcher.launch(planBase());
    expect(h.calls).toEqual([
      {
        cmd: {
          type: "launch",
          sessionId: "s1",
          socket: "mote-abc",
          cwd: "/work",
          harnessId: "claude-code",
          profile: testProfile,
          moteEnv: { MOTE_SESSION_ID: "s1" },
          mcp: undefined,
          harnessSession: undefined,
          sessionName: "s1",
          bestEffortLog: undefined,
        },
        timeoutMs: 60_000,
      },
    ]);
  });

  it("ships mcp as { path: mcpConfigPath, fileContent } and the flags that ride the wire", async () => {
    const h = makeHarness();
    const mcp = { fileContent: `{"mcpServers":{}}` } as McpRegistration;
    await h.launcher.launch({
      ...planBase(),
      mcp,
      mcpConfigPath: "/home/u/.mote-agent/mcp/s1.json",
      harnessSession: { id: "h9", mode: "resume" as const },
      bestEffortLog: true,
    });
    const cmd = h.calls[0]?.cmd as Extract<NodeCommandBody, { type: "launch" }>;
    expect(cmd.mcp).toEqual({ path: "/home/u/.mote-agent/mcp/s1.json", fileContent: `{"mcpServers":{}}` });
    expect(cmd.harnessSession).toEqual({ id: "h9", mode: "resume" });
    expect(cmd.bestEffortLog).toBe(true);
  });

  it("mcp content without mcpConfigPath throws locally without a send", async () => {
    const h = makeHarness();
    const err = (await rejection(
      h.launcher.launch({ ...planBase(), mcp: { fileContent: "{}" } as McpRegistration }),
    )) as Error;
    expect(err.message).toContain("mcpConfigPath");
    expect(h.calls).toEqual([]);
  });

  it("a `binary missing` failure refreshes the inventory (unawaited) then rethrows", async () => {
    const h = makeHarness();
    const rpcErr = new NodeRpcError("failed", 'node "node-1" reported: harness binary missing: claude-code', "node-1");
    h.answer("launch", () => {
      throw rpcErr;
    });
    expect(await rejection(h.launcher.launch(planBase()))).toBe(rpcErr);
    expect(h.calls.map((c) => c.cmd.type)).toEqual(["launch", "inventory"]);
  });

  it("other launch failures rethrow without an inventory refresh", async () => {
    const h = makeHarness();
    h.answer("launch", () => {
      throw new NodeRpcError("failed", 'node "node-1" reported: mcp path refused', "node-1");
    });
    expect(((await rejection(h.launcher.launch(planBase()))) as Error).message).toContain("mcp path refused");
    expect(h.calls.map((c) => c.cmd.type)).toEqual(["launch"]);
  });
});

describe("terminate / killSession", () => {
  it("terminate sends terminate and throws on ok:false", async () => {
    const h = makeHarness();
    await h.launcher.terminate("mote-abc", "s1");
    expect(h.calls).toEqual([{ cmd: { type: "terminate", sessionId: "s1" }, timeoutMs: 10_000 }]);

    const h2 = makeHarness();
    h2.answer("terminate", () => {
      throw new NodeRpcError("failed", 'node "node-1" reported: can\'t find session: s1', "node-1");
    });
    expect(((await rejection(h2.launcher.terminate("mote-abc", "s1"))) as Error).message).toContain(
      "can't find session",
    );
  });

  it("killSession swallows the already-gone class only", async () => {
    for (const agentMsg of ["can't find session: s1", "no session: s1"]) {
      const h = makeHarness();
      h.answer("kill", () => {
        throw new NodeRpcError("failed", `node "node-1" reported: ${agentMsg}`, "node-1");
      });
      await h.launcher.killSession("mote-abc", "s1"); // resolves
      expect(h.calls).toEqual([{ cmd: { type: "kill", sessionId: "s1" }, timeoutMs: 10_000 }]);
    }
    const h = makeHarness();
    h.answer("kill", () => {
      throw new NodeRpcError("failed", 'node "node-1" reported: no server running', "node-1");
    });
    expect(((await rejection(h.launcher.killSession("mote-abc", "s1"))) as Error).message).toContain(
      "no server running",
    );
  });
});

describe("hasSession / paneExitCode / paneTitle (one-entry probe, 5 s)", () => {
  it("hasSession reads entry.alive", async () => {
    const h = makeHarness();
    h.answer("probe", [{ sessionId: "s1", alive: true, exitCode: null }]);
    expect(await h.launcher.hasSession("sock", "s1")).toBe(true);
    expect(h.calls).toEqual([{ cmd: { type: "probe", sessionIds: ["s1"] }, timeoutMs: 5_000 }]);

    const h2 = makeHarness();
    h2.answer("probe", [{ sessionId: "s1", alive: false, exitCode: null }]);
    expect(await h2.launcher.hasSession("sock", "s1")).toBe(false);
  });

  it("paneExitCode reads entry.exitCode (null while alive)", async () => {
    const h = makeHarness();
    h.answer("probe", [{ sessionId: "s1", alive: false, exitCode: 3 }]);
    expect(await h.launcher.paneExitCode("sock", "s1")).toBe(3);
  });

  it("paneTitle needs alive + title; command defaults to empty string", async () => {
    const h = makeHarness();
    h.answer("probe", [{ sessionId: "s1", alive: true, exitCode: null, title: "working" }]);
    expect(await h.launcher.paneTitle("sock", "s1")).toEqual({ title: "working", command: "" });

    const h2 = makeHarness();
    h2.answer("probe", [{ sessionId: "s1", alive: false, exitCode: 0, title: "old" }]);
    expect(await h2.launcher.paneTitle("sock", "s1")).toBeNull();

    const h3 = makeHarness();
    h3.answer("probe", [{ sessionId: "s1", alive: true, exitCode: null }]);
    expect(await h3.launcher.paneTitle("sock", "s1")).toBeNull();
  });

  it("a malformed probe payload rejects", async () => {
    const h = makeHarness();
    h.answer("probe", { nope: true });
    expect(((await rejection(h.launcher.hasSession("sock", "s1"))) as Error).message).toContain("malformed probe");
  });
});

describe("capture / resize / sendInput / pressEnter", () => {
  it("capture (10 s) returns the bare screen string", async () => {
    const h = makeHarness();
    h.answer("capture", "  screen  ");
    expect(await h.launcher.capture("sock", "s1")).toBe("  screen  ");
    expect(h.calls).toEqual([{ cmd: { type: "capture", sessionId: "s1" }, timeoutMs: 10_000 }]);
  });

  it("resize and sendInput ride verbatim", async () => {
    const h = makeHarness();
    await h.launcher.resize("sock", "s1", 120, 40);
    await h.launcher.sendInput("sock", "s1", "ls\r");
    expect(h.calls.map((c) => c.cmd)).toEqual([
      { type: "resize", sessionId: "s1", cols: 120, rows: 40 },
      { type: "input", sessionId: "s1", data: "ls\r" },
    ]);
  });

  it("pressEnter is a literal CR through input (the pty's Enter)", async () => {
    const h = makeHarness();
    await h.launcher.pressEnter("sock", "s1");
    expect(h.calls).toEqual([{ cmd: { type: "input", sessionId: "s1", data: "\r" }, timeoutMs: 10_000 }]);
  });
});

describe("deliverPrompt", () => {
  it("sends prompt_deliver with timeout = settleTimeoutMs + 30 s", async () => {
    const h = makeHarness();
    h.answer("prompt_deliver", { promptDelivered: true });
    expect(await h.launcher.deliverPrompt("sock", "s1", "hello", 15_000, 500)).toBe(true);
    expect(h.calls).toEqual([
      {
        cmd: { type: "prompt_deliver", sessionId: "s1", text: "hello", settleTimeoutMs: 15_000, pollMs: 500 },
        timeoutMs: 45_000,
      },
    ]);
  });

  it("never throws: rpc errors and malformed answers read as false", async () => {
    const h = makeHarness();
    h.answer("prompt_deliver", () => {
      throw new NodeRpcError("timeout", "timed out", "node-1");
    });
    expect(await h.launcher.deliverPrompt("sock", "s1", "hi", 1_000, 100)).toBe(false);

    const h2 = makeHarness();
    h2.answer("prompt_deliver", { promptDelivered: "yes" });
    expect(await h2.launcher.deliverPrompt("sock", "s1", "hi", 1_000, 100)).toBe(false);
  });
});

describe("log paths and reads", () => {
  it("logPath composes from facts; throws NoLiveConnectionError (and sends nothing) without them", () => {
    const h = makeHarness();
    expect(h.launcher.logPath("s1")).toBe("/home/u/.mote-agent/sessions/s1.log");
    h.setFacts(undefined);
    expect(() => h.launcher.logPath("s1")).toThrow(NoLiveConnectionError);
    expect(h.calls).toEqual([]);
  });

  it("metaArtifactPath pins the agent's `<dataDir>/sessions/<id>.meta.json` layout", () => {
    // Pinned against apps/agent/src/session-meta.ts: SessionMetaStore.metaPath =
    // join(dataDir, "sessions", `${id}${".meta.json"}`). The manager feeds this
    // into the delete-time `remove_paths` so a deliberate delete unlinks the
    // agent's per-session record alongside the log and the MCP config.
    const h = makeHarness();
    expect(h.launcher.metaArtifactPath("s1")).toBe("/home/u/.mote-agent/sessions/s1.meta.json");
    h.setFacts(undefined);
    expect(() => h.launcher.metaArtifactPath("s1")).toThrow(NoLiveConnectionError);
    expect(h.calls).toEqual([]);
  });

  it("readLog decodes bytes and keeps next; readLogSized adds size", async () => {
    const h = makeHarness();
    h.answer("log_read", { bytes_b64: b64("hello"), next: 5, size: 40 });
    const r = await h.launcher.readLog("s1", 0, 5);
    expect(Buffer.from(r.bytes).toString("utf8")).toBe("hello");
    expect(r.next).toBe(5);
    expect(Object.keys(r)).toEqual(["bytes", "next"]); // frozen wrapper drops size

    const h2 = makeHarness();
    h2.answer("log_read", { bytes_b64: b64("hello"), next: 5, size: 40 });
    const s = await h2.launcher.readLogSized("s1", 0, 5);
    expect(s).toEqual({ bytes: s.bytes, next: 5, size: 40 });
    expect(Buffer.from(s.bytes).toString("utf8")).toBe("hello");
    expect(h2.calls[0]).toEqual({
      cmd: { type: "log_read", sessionId: "s1", fromByte: 0, maxBytes: 5 },
      timeoutMs: 10_000,
    });
  });

  it("readLogTail reads size via log_read(0,1), then the window, with local-identical math", async () => {
    const h = makeHarness();
    h.answer("log_read", { bytes_b64: b64("a"), next: 1, size: 9 });
    h.answer("log_read", { bytes_b64: b64("l1\nl2\n"), next: 9, size: 9 });
    expect(await h.launcher.readLogTail("s1")).toEqual({ lines: ["l1", "l2"], truncated: false });
    expect(h.calls.map((c) => c.cmd)).toEqual([
      { type: "log_read", sessionId: "s1", fromByte: 0, maxBytes: 1 },
      { type: "log_read", sessionId: "s1", fromByte: 0, maxBytes: 256 * 1024 },
    ]);
  });

  it("readLogTail windows past LOG_TAIL_BYTES, drops the partial line, flags truncation", async () => {
    const h = makeHarness();
    const size = 300_000;
    const start = size - 256 * 1024;
    h.answer("log_read", { bytes_b64: b64("z"), next: 1, size });
    h.answer("log_read", { bytes_b64: b64("partial\nfull line\n"), next: size, size });
    expect(await h.launcher.readLogTail("s1")).toEqual({ lines: ["full line"], truncated: true });
    expect(h.calls[1]?.cmd).toEqual({ type: "log_read", sessionId: "s1", fromByte: start, maxBytes: 256 * 1024 });
  });

  it("an empty log (size 0) tails as { lines: [], truncated: false } like local", async () => {
    const h = makeHarness();
    h.answer("log_read", { bytes_b64: "", next: 0, size: 0 });
    h.answer("log_read", { bytes_b64: "", next: 0, size: 0 });
    expect(await h.launcher.readLogTail("s1")).toEqual({ lines: [], truncated: false });
  });
});

describe("tailStart relay", () => {
  it("subscribes BEFORE sending tail_start (early events are not dropped)", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    let subscribedDuringRpc: boolean | undefined;
    h.answer("tail_start", () => {
      // The agent's catch-up pump can fire before the result lands: prove the
      // bus already has this subId by dispatching mid-round-trip.
      subscribedDuringRpc = dispatchOutput(
        outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 0, toByte: 3, data_b64: b64("abc") }),
      );
      return undefined;
    });
    const dispose = await h.launcher.tailStart("s1", "sub-1", 0, (bytes) => seen.push(Buffer.from(bytes).toString()));
    await flush();
    expect(subscribedDuringRpc).toBe(true);
    expect(seen).toEqual(["abc"]);
    dispose();
  });

  it("delivers in-order events with monotonic cursors", async () => {
    const h = makeHarness();
    const chunks: Array<[string, number]> = [];
    const dispose = await h.launcher.tailStart("s1", "sub-1", 0, (b, next) =>
      chunks.push([Buffer.from(b).toString(), next]),
    );
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 0, toByte: 3, data_b64: b64("abc") }));
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 3, toByte: 6, data_b64: b64("def") }));
    await flush();
    expect(chunks).toEqual([
      ["abc", 3],
      ["def", 6],
    ]);
    dispose();
  });

  it("GAP: backfills via log_read and emits it BEFORE the event bytes", async () => {
    const h = makeHarness();
    const chunks: Array<[string, number]> = [];
    h.answer("log_read", { bytes_b64: b64("gapfill"), next: 107, size: 200 });
    const dispose = await h.launcher.tailStart("s1", "sub-1", 100, (b, next) =>
      chunks.push([Buffer.from(b).toString(), next]),
    );
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 107, toByte: 110, data_b64: b64("xyz") }));
    await flush();
    expect(h.calls).toEqual([
      { cmd: { type: "tail_start", sessionId: "s1", subId: "sub-1", fromByte: 100 }, timeoutMs: 10_000 },
      { cmd: { type: "log_read", sessionId: "s1", fromByte: 100, maxBytes: 7 }, timeoutMs: 10_000 },
    ]);
    expect(chunks).toEqual([
      ["gapfill", 107],
      ["xyz", 110],
    ]);
    dispose();
  });

  it("GAP with an empty (clamped-next) backfill still delivers the event payload", async () => {
    const h = makeHarness();
    const chunks: Array<[string, number]> = [];
    // The agent clamps `next` to `size` on empty reads — here size == cursor,
    // so the backfill carries nothing and must not move or stall the relay.
    h.answer("log_read", { bytes_b64: "", next: 100, size: 100 });
    const dispose = await h.launcher.tailStart("s1", "sub-1", 100, (b, next) =>
      chunks.push([Buffer.from(b).toString(), next]),
    );
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 110, toByte: 113, data_b64: b64("xyz") }));
    await flush();
    expect(chunks).toEqual([["xyz", 113]]);
    dispose();
  });

  it("GAP whose backfill itself fails still delivers the event bytes", async () => {
    const h = makeHarness();
    const chunks: Array<[string, number]> = [];
    h.answer("log_read", () => {
      throw new NodeRpcError("offline", 'node "node-1" has no live connection', "node-1");
    });
    const dispose = await h.launcher.tailStart("s1", "sub-1", 100, (b, next) =>
      chunks.push([Buffer.from(b).toString(), next]),
    );
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 105, toByte: 108, data_b64: b64("xyz") }));
    await flush();
    expect(chunks).toEqual([["xyz", 108]]);
    dispose();
  });

  it("DUP: an event overlapping the cursor delivers only the missing suffix", async () => {
    const h = makeHarness();
    const chunks: Array<[string, number]> = [];
    const dispose = await h.launcher.tailStart("s1", "sub-1", 0, (b, next) =>
      chunks.push([Buffer.from(b).toString(), next]),
    );
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 0, toByte: 5, data_b64: b64("hello") }));
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 2, toByte: 8, data_b64: b64("lloAB") }));
    await flush();
    expect(chunks).toEqual([
      ["hello", 5],
      ["AB", 8],
    ]);
    dispose();
  });

  it("events for another sessionId are ignored", async () => {
    const h = makeHarness();
    const chunks: string[] = [];
    const dispose = await h.launcher.tailStart("s1", "sub-1", 0, (b) => chunks.push(Buffer.from(b).toString()));
    dispatchOutput(outputEvent({ sessionId: "other", subId: "sub-1", fromByte: 0, toByte: 2, data_b64: b64("no") }));
    await flush();
    expect(chunks).toEqual([]);
    dispose();
  });

  it("DISPOSED mid-backfill: neither the backfill-resume nor a later event fires onChunk", async () => {
    const h = makeHarness();
    const chunks: Array<[string, number]> = [];
    // A gap forces the queue task to park on a backfill whose resolution we
    // control — dispose happens exactly while that responder is pending.
    let resolveBackfill: ((v: unknown) => void) | undefined;
    h.answer("log_read", () => {
      return new Promise((resolve) => {
        resolveBackfill = resolve;
      });
    });
    const dispose = await h.launcher.tailStart("s1", "sub-1", 100, (b, next) =>
      chunks.push([Buffer.from(b).toString(), next]),
    );
    dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 107, toByte: 110, data_b64: b64("xyz") }));
    await flush(); // the task is now parked mid-`await` on the backfill
    dispose(); // disposed WHILE the backfill responder is pending
    resolveBackfill?.({ bytes_b64: b64("gapfill"), next: 107, size: 200 });
    await flush(); // backfill resolves: the guard must swallow BOTH deliveries
    expect(chunks).toEqual([]);
    // And a fresh dispatch finds no subscriber — the bus was unsubscribed.
    expect(
      dispatchOutput(
        outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 110, toByte: 113, data_b64: b64("123") }),
      ),
    ).toBe(false);
    await flush();
    expect(chunks).toEqual([]);
  });

  it("the disposer unsubscribes and fires tail_stop (5 s), swallowing failures", async () => {
    const h = makeHarness();
    const dispose = await h.launcher.tailStart("s1", "sub-1", 0, () => {});
    h.answer("tail_stop", () => {
      throw new NodeRpcError("timeout", "no answer", "node-1");
    });
    dispose();
    await flush();
    expect(h.calls).toEqual([
      { cmd: { type: "tail_start", sessionId: "s1", subId: "sub-1", fromByte: 0 }, timeoutMs: 10_000 },
      { cmd: { type: "tail_stop", subId: "sub-1" }, timeoutMs: 5_000 },
    ]);
    expect(
      dispatchOutput(outputEvent({ sessionId: "s1", subId: "sub-1", fromByte: 0, toByte: 1, data_b64: b64("x") })),
    ).toBe(false); // nobody listening anymore — the bus dropped it
  });
});

describe("canResume", () => {
  it("sends probe_resume and reads the answer", async () => {
    const h = makeHarness();
    h.answer("probe_resume", { canResume: true });
    expect(await h.launcher.canResume(harness, "h9", "/work")).toBe(true);
    expect(h.calls).toEqual([
      {
        cmd: { type: "probe_resume", harnessId: "claude-code", harnessSessionId: "h9", cwd: "/work" },
        timeoutMs: 10_000,
      },
    ]);
  });

  it("any rpc error reads as false (dead node ⇒ fresh id, like local)", async () => {
    const h = makeHarness();
    h.answer("probe_resume", () => {
      throw new NodeRpcError("offline", 'node "node-1" has no live connection', "node-1");
    });
    expect(await h.launcher.canResume(harness, "h9", "/work")).toBe(false);
  });
});

describe("writeArtifact / removeArtifacts", () => {
  it("writeArtifact ships ONE chunk to <dataDir>/mcp/<id>.json and returns the path", async () => {
    const h = makeHarness();
    const path = await h.launcher.writeArtifact(UUID, "mcp-config", '{"a":1}');
    expect(path).toBe(artifactPath);
    expect(h.calls).toEqual([
      {
        cmd: {
          type: "write_file",
          path: artifactPath,
          chunk_b64: b64('{"a":1}'),
          chunk: 0,
          eof: true,
        },
        timeoutMs: 30_000,
      },
    ]);
  });

  it("a non-uuid id is rejected LOCALLY (an empty/unsafe path never reaches write_file)", async () => {
    for (const bad of ["", "../evil", "not an id", "x".repeat(65)]) {
      const h = makeHarness();
      const err = (await rejection(h.launcher.writeArtifact(bad, "mcp-config", "{}"))) as Error;
      expect(err.message).toContain("invalid session id");
      expect(h.calls).toEqual([]);
    }
  });

  it("writeArtifact without facts throws NoLiveConnectionError without a send", async () => {
    const h = makeHarness();
    h.setFacts(undefined);
    expect(await rejection(h.launcher.writeArtifact(UUID, "mcp-config", "{}"))).toBeInstanceOf(NoLiveConnectionError);
    expect(h.calls).toEqual([]);
  });

  it("removeArtifacts sends remove_paths (10 s) and swallows every rpc error", async () => {
    const h = makeHarness();
    await h.launcher.removeArtifacts(["/home/u/.mote-agent/mcp/s1.json"]);
    expect(h.calls).toEqual([
      { cmd: { type: "remove_paths", paths: ["/home/u/.mote-agent/mcp/s1.json"] }, timeoutMs: 10_000 },
    ]);

    const h2 = makeHarness();
    h2.answer("remove_paths", () => {
      throw new NodeRpcError("failed", 'node "node-1" reported: boom', "node-1");
    });
    await h2.launcher.removeArtifacts(["/x"]); // resolves anyway
  });

  it("removeArtifacts([]) never touches the wire", async () => {
    const h = makeHarness();
    await h.launcher.removeArtifacts([]);
    expect(h.calls).toEqual([]);
  });
});

describe("offline short-circuit (no facts ⇒ no send)", () => {
  it("facts-dependent members fail before the wire; never-throws members stay soft", async () => {
    const h = makeHarness(null);
    expect(() => h.launcher.logPath("s1")).toThrow(NoLiveConnectionError);
    await rejection(h.launcher.writeArtifact(UUID, "mcp-config", "{}"));
    expect(h.calls).toEqual([]);

    // Non-facts members do go through `send` — with the REAL offline rpc error
    // they degrade exactly like the frozen contract demands.
    const offline = () => {
      throw new NodeRpcError("offline", 'node "node-1" has no live connection', "node-1");
    };
    h.answer("prompt_deliver", offline);
    h.answer("probe_resume", offline);
    h.answer("remove_paths", offline);
    h.answer("launch", offline);
    expect(await h.launcher.deliverPrompt("sock", "s1", "x", 100, 10)).toBe(false);
    expect(await h.launcher.canResume(harness, "h", "/w")).toBe(false);
    await h.launcher.removeArtifacts(["/p"]);
    await rejection(
      h.launcher.launch({
        id: "s1",
        socket: "sock",
        harness,
        binary: "/b",
        cwd: "/w",
        profile: testProfile,
        sessionName: "s1",
        moteEnv: {},
      }),
    ); // launch still surfaces the failure
  });
});

describe("launcher-registry", () => {
  it("local resolves to the shared LocalLauncher; agent ids get cached RemoteLaunchers", () => {
    expect(launcherFor(LOCAL_NODE_ID)).toBe(defaultLocalLauncher);
    const a = launcherFor("node-1");
    expect(a).toBeInstanceOf(RemoteLauncher);
    expect(launcherFor("node-1")).toBe(a); // per-id cache — stateless besides nodeId
    expect(launcherFor("node-2")).not.toBe(a);
    resetLauncherRegistryForTests();
    expect(launcherFor("node-1")).not.toBe(a);
  });
});
