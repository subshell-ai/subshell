import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  MIN_AGENT_VERSION,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
} from "@internal/subshell-protocol";
import { dispatchOutput, resetNodeEventsForTests, setNodeLifecycleHooks, subscribeOutput } from "../node-events.js";
import { resetNodeRegistryForTests } from "../node-registry.js";
import {
  handleNodeMessage,
  handleNodeMessageQueued,
  handleNodeOpen,
  type NodeWsDeps,
  type NodeWsSocket,
} from "../node-ws-handler.js";

/**
 * Task 7 event plane: the output bus (subscribe/dispose/dispatch), the agent
 * facts stashed on the connection by `ready`, the lifecycle-hook slot fed by
 * `exit`/`subshells_report`, and per-socket serialized dispatch (spec §3.3,
 * P1-T10 carry).
 */

/* ---------------------------- fakes ----------------------------- */

interface FakeNodeSocket extends NodeWsSocket {
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

function fakeSocket(nodeId?: string): FakeNodeSocket {
  return {
    data: nodeId ? { nodeId, apiKeyId: "k-n1" } : {},
    sent: [],
    closed: [],
    send(d: string) {
      this.sent.push(d);
      return d.length;
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
    },
  };
}

/** Call-order log across the repo fakes; `touch` blocks on a deferred promise. */
interface Harness {
  deps: NodeWsDeps;
  order: string[];
  releaseTouch: () => void;
}

function makeHarness(): Harness {
  const h: Harness = { deps: undefined as unknown as NodeWsDeps, order: [], releaseTouch: () => {} };
  const resolvers: (() => void)[] = [];
  h.deps = {
    verifyApiKey: async () => null,
    nodes: {
      findById: async () => undefined,
      applyReady: async (id: string) => {
        h.order.push(`ready:${id}`);
      },
      applyInventory: async (id: string) => {
        h.order.push(`inventory:${id}`);
      },
      // Heartbeat handler awaits this; the test releases it to unblock the queue.
      touch: async (id: string) => {
        h.order.push(`touch:${id}`);
        await new Promise<void>((r) => {
          resolvers.push(r);
        });
      },
      setStatus: async () => {},
    } as unknown as NodeWsDeps["nodes"],
    resolveResult: () => false,
  };
  h.releaseTouch = () => {
    for (const r of resolvers.splice(0)) r();
  };
  return h;
}

const readyFrame = (over: Record<string, unknown> = {}) => ({
  type: "ready",
  agentVersion: MIN_AGENT_VERSION,
  protocolVersion: NODE_PROTOCOL_VERSION,
  os: "linux",
  arch: "x64",
  hostname: "box",
  dataDir: "/home/u/.local/share/subshell",
  capabilities: ["uploads"],
  ...over,
});

const outputFrame = (over: Record<string, unknown> = {}) => ({
  type: "output",
  subshellId: "s1",
  subId: "sub-1",
  fromByte: 0,
  toByte: 2,
  data_b64: "aGk=",
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
});

afterEach(() => {
  resetNodeEventsForTests();
});

/* ------------------------- output bus --------------------------- */

describe("subscribeOutput / dispatchOutput (spec §3.3)", () => {
  it("dispatch reaches the subscriber and returns true; the disposer unsubscribes", () => {
    const seen: Extract<NodeEvent, { type: "output" }>[] = [];
    const dispose = subscribeOutput("sub-1", (ev) => seen.push(ev));

    expect(dispatchOutput(outputFrame() as Extract<NodeEvent, { type: "output" }>)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.subshellId).toBe("s1");

    dispose();
    expect(dispatchOutput(outputFrame() as Extract<NodeEvent, { type: "output" }>)).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("unknown subId ⇒ false", () => {
    expect(dispatchOutput(outputFrame({ subId: "nobody-home" }) as Extract<NodeEvent, { type: "output" }>)).toBe(false);
  });

  it("two subscribers on one subId both receive; a disposer only removes its own handler", () => {
    const a: string[] = [];
    const b: string[] = [];
    const disposeA = subscribeOutput("sub-1", () => a.push("a"));
    subscribeOutput("sub-1", () => b.push("b"));

    expect(dispatchOutput(outputFrame() as Extract<NodeEvent, { type: "output" }>)).toBe(true);
    expect(a).toEqual(["a"]);
    expect(b).toEqual(["b"]);

    disposeA();
    expect(dispatchOutput(outputFrame() as Extract<NodeEvent, { type: "output" }>)).toBe(true);
    expect(a).toEqual(["a"]); // untouched by the second dispatch
    expect(b).toEqual(["b", "b"]);
  });

  it("a disposer is idempotent", () => {
    const dispose = subscribeOutput("sub-1", () => {});
    dispose();
    expect(() => dispose()).not.toThrow();
    expect(dispatchOutput(outputFrame() as Extract<NodeEvent, { type: "output" }>)).toBe(false);
  });
});

/* ------------------- agent facts on `ready` ---------------------- */

describe("ready → connection.agent (NodeAgentFacts, spec §6.4)", () => {
  it("sets ws.data.nodeConn.agent EXACTLY from the frame when selfInvoke is present", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    const conn = ws.data.nodeConn;
    if (!conn) throw new Error("open must stash the registry record on ws.data");

    await handleNodeMessage(
      h.deps,
      ws,
      JSON.stringify(
        readyFrame({
          selfInvoke: { command: "/usr/local/bin/bun", args: ["/opt/subshell/src/index.ts"] },
          homeDir: "/home/u",
        }),
      ),
    );

    expect(conn.agent).toEqual({
      dataDir: "/home/u/.local/share/subshell",
      capabilities: ["uploads"],
      hostname: "box",
      agentVersion: MIN_AGENT_VERSION,
      selfInvoke: { command: "/usr/local/bin/bun", args: ["/opt/subshell/src/index.ts"] },
      homeDir: "/home/u",
    });
  });

  it("a ready frame carries NO env: the resume-path values arrive on detect, and ready cannot stash them", async () => {
    // R14b: the field left the wire. A frame bearing `env` parses (unknown
    // keys pass) but must NEVER reach the facts — and the selfInvoke/homeDir
    // halves stay ABSENT when unreported, never undefined-valued keys a
    // later `in`-check would misread.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    const conn = ws.data.nodeConn;
    if (!conn) throw new Error("open must stash the registry record on ws.data");

    await handleNodeMessage(h.deps, ws, JSON.stringify({ ...readyFrame(), env: { CLAUDE_CONFIG_DIR: "/x" } }));

    expect(conn.agent).toEqual({
      dataDir: "/home/u/.local/share/subshell",
      capabilities: ["uploads"],
      hostname: "box",
      agentVersion: MIN_AGENT_VERSION,
    });
    for (const key of ["selfInvoke", "homeDir", "env"] as const) {
      expect(conn.agent && key in conn.agent).toBe(false);
    }
  });

  it("records facts even for an agent it is about to refuse (diagnosis first)", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    const conn = ws.data.nodeConn;
    if (!conn) throw new Error("open must stash the registry record on ws.data");

    await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame({ protocolVersion: 999 })));

    // Recorded BEFORE the refusal, on purpose: an operator diagnosing a node
    // that will not connect needs to see what it reported.
    expect(conn.agent?.agentVersion).toBe(MIN_AGENT_VERSION);
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0]?.reason).toContain(`v${NODE_PROTOCOL_VERSION}`);
  });
});

/* ------------------ lifecycle hook slot -------------------------- */

describe("exit / subshells_report → lifecycle hooks (spec §3.3)", () => {
  it("exit reaches the registered hook with the SOCKET's nodeId, never a frame-supplied one", async () => {
    const seen: [string, string, number | null, string][] = [];
    setNodeLifecycleHooks({
      onExit: (nodeId, subshellId, exitCode, at) => {
        seen.push([nodeId, subshellId, exitCode, at]);
      },
      onSubshellsReport: () => {},
      onMaintenance: () => {},
    });
    const h = makeHarness();
    const ws = fakeSocket("n1");

    // The frame carries a spoofed nodeId — it must be ignored entirely.
    await handleNodeMessage(
      h.deps,
      ws,
      JSON.stringify({
        type: "exit",
        nodeId: "victim-node",
        subshellId: "s9",
        exitCode: 3,
        at: "2026-09-01T00:00:00Z",
      }),
    );

    expect(seen).toEqual([["n1", "s9", 3, "2026-09-01T00:00:00Z"]]);
  });

  it("subshells_report reaches the hook with the socket's nodeId and the subshell list", async () => {
    const seen: { nodeId: string; report: unknown }[] = [];
    setNodeLifecycleHooks({
      onExit: () => {},
      onMaintenance: () => {},
      onSubshellsReport: (nodeId, report) => {
        seen.push({ nodeId, report });
      },
    });
    const h = makeHarness();
    const subshells = [{ subshellId: "s1", alive: false, exitCode: 0 }];

    await handleNodeMessage(h.deps, fakeSocket("n7"), JSON.stringify({ type: "subshells_report", subshells }));

    expect(seen).toEqual([{ nodeId: "n7", report: subshells }]);
  });

  it("no hook registered ⇒ frames are ingested with a warn line and nothing else", async () => {
    setNodeLifecycleHooks(undefined);
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await expect(
      handleNodeMessage(h.deps, ws, JSON.stringify({ type: "exit", subshellId: "s", exitCode: null, at: "now" })),
    ).resolves.toBeUndefined();
    await expect(
      handleNodeMessage(h.deps, ws, JSON.stringify({ type: "subshells_report", subshells: [] })),
    ).resolves.toBeUndefined();
    expect(h.order).toEqual([]);
    expect(ws.closed).toHaveLength(0);
  });

  it("output frames with no subscriber are dropped without closing the socket", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, JSON.stringify(outputFrame()));
    expect(ws.closed).toHaveLength(0);
    expect(h.order).toEqual([]);
  });
});

/* ---------------- serialized dispatch ---------------------------- */

describe("handleNodeMessageQueued (P1-T10: per-socket serialization)", () => {
  it("a frame behind a blocked heartbeat runs only after the block resolves", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");

    const p1 = handleNodeMessageQueued(h.deps, ws, JSON.stringify({ type: "heartbeat", ts: "now" }));
    const p2 = handleNodeMessageQueued(
      h.deps,
      ws,
      JSON.stringify({
        type: "inventory",
        // Non-empty on purpose: the Task 7 guard skips EMPTY harness arrays
        // (a plugin-less agent's filler claim); this test is about frame
        // ORDERING, so it must present a claim the handler will act on.
        harnesses: [{ harnessId: "hermes", installed: true }],
        ts: "now",
      }),
    );
    await flush();

    // The inventory frame arrived second but its applyInventory must NOT have
    // run yet: the queued heartbeat still holds the per-socket chain.
    expect(h.order).toEqual(["touch:n1"]);
    h.releaseTouch();
    await Promise.all([p1, p2]);

    expect(h.order).toEqual(["touch:n1", "inventory:n1"]);
  });

  it("a rejected frame does not poison the queue for later frames", async () => {
    const h = makeHarness();
    const boom = new Error("db on fire");
    h.deps.nodes.applyReady = async () => {
      throw boom;
    };
    const ws = fakeSocket("n1");

    const p1 = handleNodeMessageQueued(h.deps, ws, JSON.stringify(readyFrame()));
    const p2 = handleNodeMessageQueued(
      h.deps,
      ws,
      JSON.stringify({
        type: "inventory",
        // Non-empty on purpose: the Task 7 guard skips EMPTY harness arrays
        // (a plugin-less agent's filler claim); this test is about frame
        // ORDERING, so it must present a claim the handler will act on.
        harnesses: [{ harnessId: "hermes", installed: true }],
        ts: "now",
      }),
    );

    await expect(p1).rejects.toBe(boom);
    await expect(p2).resolves.toBeUndefined();
    expect(h.order).toEqual(["inventory:n1"]);
  });

  it("frames on DIFFERENT sockets do not wait on each other", async () => {
    const h = makeHarness();
    const slow = fakeSocket("n1");
    const fast = fakeSocket("n2");

    const p1 = handleNodeMessageQueued(h.deps, slow, JSON.stringify({ type: "heartbeat", ts: "now" }));
    const p2 = handleNodeMessageQueued(h.deps, fast, JSON.stringify({ type: "heartbeat", ts: "now" }));
    await flush();

    // n1's heartbeat is stuck on the deferred touch; n2's ran through its own chain.
    expect(h.order).toEqual(["touch:n1", "touch:n2"]);
    h.releaseTouch();
    await Promise.all([p1, p2]);
    expect(h.order).toEqual(["touch:n1", "touch:n2"]);
  });
});
