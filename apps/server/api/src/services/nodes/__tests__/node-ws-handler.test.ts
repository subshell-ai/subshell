import { beforeEach, describe, expect, it } from "bun:test";
import {
  MIN_AGENT_VERSION,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
} from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import type { NodeReadyReport } from "@/db/repositories/nodes.repository.js";
import type { NodeKind, NodeTable } from "@/db/types/nodes.db-types.js";
import { getLive, type NodeConnection, resetNodeRegistryForTests } from "../node-registry.js";
import { NodeRpcError } from "../node-rpc.js";
import {
  authenticateNodeUpgrade,
  handleNodeClose,
  handleNodeMessage,
  handleNodeOpen,
  NODE_CLOSE_TOO_BIG,
  NODE_CLOSE_UNAUTHENTICATED,
  type NodeWsDeps,
  type NodeWsSocket,
} from "../node-ws-handler.js";

/* ---------------------------- fakes ----------------------------- */

/** Scripted socket: records sends and closes, carries `data` like ElysiaWS. */
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

/** Key rows / node rows the fake deps resolve, plus every recorded call. */
interface Harness {
  deps: NodeWsDeps;
  /** raw bearer key → verified row (absent/null = invalid) */
  keys: Map<string, { id: string; metadata: Record<string, unknown> | null } | null>;
  /** node id → apiKeyId the row binds (absent = no row) */
  bindings: Map<string, string | null>;
  /** node id → row `kind` (absent = "agent") */
  kinds: Map<string, NodeKind>;
  ready: { id: string; report: NodeReadyReport }[];
  inventories: { id: string; json: string }[];
  touched: string[];
  statuses: { id: string; status: string }[];
  /** what deps.resolveResult saw: the connection handed to it + the event */
  results: { conn: NodeConnection; event: Extract<NodeEvent, { type: "result" }> }[];
  inventoryRequests: string[];
  /** when set, deps.resolveResult returns false instead of true */
  resultMiss: boolean;
}

function makeHarness(): Harness {
  const h = {
    keys: new Map(),
    bindings: new Map(),
    kinds: new Map(),
    ready: [],
    inventories: [],
    touched: [],
    statuses: [],
    results: [],
    inventoryRequests: [],
    resultMiss: false,
  } as unknown as Harness;
  h.deps = {
    verifyApiKey: async (rawKey) => h.keys.get(rawKey) ?? null,
    nodes: {
      findById: async (id) =>
        h.bindings.has(id)
          ? ({ id, apiKeyId: h.bindings.get(id) ?? null, kind: h.kinds.get(id) ?? "agent" } as unknown as NodeTable)
          : undefined,
      applyReady: async (id, report) => {
        h.ready.push({ id, report });
        return undefined;
      },
      applyInventory: async (id, json) => {
        h.inventories.push({ id, json });
      },
      touch: async (id) => {
        h.touched.push(id);
      },
      setStatus: async (id, status) => {
        h.statuses.push({ id, status });
      },
    } as unknown as NodeWsDeps["nodes"],
    resolveResult: (conn, event) => {
      h.results.push({ conn, event });
      return !h.resultMiss;
    },
    requestInventory: (nodeId) => {
      h.inventoryRequests.push(nodeId);
    },
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

/* ------------------- upgrade authentication --------------------- */

describe("authenticateNodeUpgrade (spec §5.3 pre-socket tier)", () => {
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("refuses 401: missing header, non-bearer form, unknown key", async () => {
    const h = makeHarness();
    await expect(authenticateNodeUpgrade(h.deps, null)).rejects.toThrow(HttpError);
    await expect(authenticateNodeUpgrade(h.deps, null)).rejects.toMatchObject({ status: 401 });
    await expect(authenticateNodeUpgrade(h.deps, "Basic nope")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateNodeUpgrade(h.deps, "Bearer ghost-key")).rejects.toMatchObject({ status: 401 });
  });

  it("refuses 401: non-node key kinds and node keys whose row is gone", async () => {
    const h = makeHarness();
    h.keys.set("sess", { id: "k1", metadata: { kind: "subshell", subshellId: "s1" } });
    h.keys.set("orphan", { id: "k2", metadata: { kind: "node", nodeId: "n-gone" } });
    await expect(authenticateNodeUpgrade(h.deps, "Bearer sess")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateNodeUpgrade(h.deps, "Bearer orphan")).rejects.toMatchObject({ status: 401 });
  });

  it("refuses 403: key validates but the node row binds a different key (rotation/stale)", async () => {
    const h = makeHarness();
    h.keys.set("old", { id: "k-old", metadata: { kind: "node", nodeId: "n1" } });
    h.bindings.set("n1", "k-new");
    await expect(authenticateNodeUpgrade(h.deps, "Bearer old")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses 403: fully linked node key aimed at the LOCAL node row (it never dials in)", async () => {
    // A rotated local key (admin-only mint surface) must not impersonate the
    // control-plane host over /ws/node and overwrite its facts via ready.
    const h = makeHarness();
    h.keys.set("local", { id: "k-local", metadata: { kind: "node", nodeId: "local" } });
    h.bindings.set("local", "k-local"); // key↔row link is CORRECT — only `kind` refuses
    h.kinds.set("local", "local");
    await expect(authenticateNodeUpgrade(h.deps, "Bearer local")).rejects.toMatchObject({
      status: 403,
      message: "The local node cannot connect over /ws/node",
    });
  });

  it("accepts the fully linked chain and passes the RAW key (bearer prefix stripped) to the verifier", async () => {
    const h = makeHarness();
    h.keys.set("good", { id: "k1", metadata: { kind: "node", nodeId: "n1" } });
    h.bindings.set("n1", "k1");
    await expect(authenticateNodeUpgrade(h.deps, "Bearer good")).resolves.toEqual({ nodeId: "n1", apiKeyId: "k1" });
  });
});

/* ---------------------------- open ------------------------------ */

describe("handleNodeOpen", () => {
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("attaches the authenticated socket to the registry", () => {
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    expect(getLive("n1")?.ws).toBe(ws);
    expect(ws.data.nodeConn).toBe(getLive("n1"));
    // Open does NOT write — status flips online only with `ready`.
    expect(ws.closed).toHaveLength(0);
  });

  it("closes 4401 when no identity was stashed (never-authenticated socket)", () => {
    const ws = fakeSocket();
    handleNodeOpen(ws);
    expect(ws.closed).toEqual([{ code: NODE_CLOSE_UNAUTHENTICATED, reason: expect.any(String) }]);
    expect(getLive("n1")).toBeUndefined();
  });

  it("second attach supersedes the first with 4409 (registry semantics)", () => {
    const first = fakeSocket("n1");
    handleNodeOpen(first);
    const second = fakeSocket("n1");
    handleNodeOpen(second);
    expect(first.closed.map((c) => c.code)).toEqual([4409]);
    expect(getLive("n1")?.ws).toBe(second);
  });
});

/* --------------------------- message ---------------------------- */

describe("handleNodeMessage (inbound unsigned events, spec §3.3/§5.3)", () => {
  it("ready → applyReady with the mapped report, then an inventory refresh (spec §5.3)", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame()));
    expect(h.ready).toEqual([
      {
        id: "n1",
        report: {
          agentVersion: MIN_AGENT_VERSION,
          protocolVersion: NODE_PROTOCOL_VERSION,
          os: "linux",
          arch: "x64",
          hostname: "box",
          capabilities: ["uploads"],
        },
      },
    ]);
    expect(h.inventoryRequests).toEqual(["n1"]);
    expect(ws.closed).toHaveLength(0);
  });

  it("ready stashes homeDir and env on the live facts; a node reporting neither keeps them absent", async () => {
    // Spec 2026-09-10 §5: `remote-launcher.canResume` computes the plugin's
    // path from these, and the "reported no env" branch is a real node state
    // (one that connected before the field existed), not a hypothetical.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ homeDir: "/home/n", env: { CLAUDE_CONFIG_DIR: "/custom" } }));
    expect(getLive("n1")?.agent).toMatchObject({ homeDir: "/home/n", env: { CLAUDE_CONFIG_DIR: "/custom" } });

    const h2 = makeHarness();
    const ws2 = fakeSocket("n2");
    handleNodeOpen(ws2);
    await handleNodeMessage(h2.deps, ws2, readyFrame());
    const plain = getLive("n2")?.agent;
    expect(plain).toMatchObject({ hostname: "box" });
    expect(plain).not.toHaveProperty("homeDir");
    expect(plain).not.toHaveProperty("env");
  });

  it("ready with a foreign protocol → recorded FIRST, then close 4406, no inventory", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, readyFrame({ protocolVersion: 999 }));
    expect(h.ready).toHaveLength(1); // persisted so the UI can say "agent too old"
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(h.inventoryRequests).toEqual([]);
  });

  it("ready at the agent floor → accepted, inventory still requested", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: MIN_AGENT_VERSION }));
    expect(ws.closed).toHaveLength(0);
    expect(h.inventoryRequests).toEqual(["n1"]);
  });

  it("refuses an agent below the floor, and the reason names BOTH versions", async () => {
    // The whole point of the floor over a bare protocol number: the operator
    // is told what to install and what they are running. A message naming
    // neither is a support ticket.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(ws.closed).toHaveLength(1);
    expect(ws.closed[0].code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0].reason).toContain(MIN_AGENT_VERSION);
    expect(ws.closed[0].reason).toContain("0.0.1");
  });

  it("refuses an agent that cannot say what version it is", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "" }));
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0]?.reason).toContain("unversioned");
  });

  it("keeps the protocol check as a backstop, with a reason that says so", async () => {
    // Unreachable if the floor is set right — an agent above the floor ships
    // the current protocol — so this fires only when the floor itself is
    // wrong, and the message has to distinguish that from the floor refusal.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(
      h.deps,
      ws,
      readyFrame({ agentVersion: "99.0.0", protocolVersion: NODE_PROTOCOL_VERSION + 1 }),
    );
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0]?.reason).toContain(`v${NODE_PROTOCOL_VERSION}`);
  });

  it("the backstop refuses an agent BEHIND the protocol too, not just ahead of it", async () => {
    // The direction the previous suite covered and the rewrite dropped: a
    // version-current agent speaking an older protocol. It is the case the
    // node detail page's "agent too old" chip is driven by, and without it a
    // `>=` slipping into the comparison would let a behind-protocol agent
    // through with a green suite.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(
      h.deps,
      ws,
      readyFrame({ agentVersion: "99.0.0", protocolVersion: NODE_PROTOCOL_VERSION - 1 }),
    );
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0]?.reason).toContain(`v${NODE_PROTOCOL_VERSION}`);
  });

  it("heartbeat → touch only", async () => {
    const h = makeHarness();
    await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify({ type: "heartbeat", ts: "now" }));
    expect(h.touched).toEqual(["n1"]);
    expect(h.ready).toHaveLength(0);
  });

  it("inventory → applyInventory with the JSON-encoded harness list", async () => {
    const h = makeHarness();
    const harnesses = [{ harnessId: "claude-code", installed: true, version: "1.2.3" }];
    await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify({ type: "inventory", harnesses, ts: "now" }));
    expect(h.inventories).toEqual([{ id: "n1", json: JSON.stringify(harnesses) }]);
  });

  it("result → resolveResult on the socket's OWN connection; unknown ref is a debug no-op", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws); // stashes ws.data.nodeConn — the connection-scoping anchor
    const ev: Extract<NodeEvent, { type: "result" }> = { type: "result", ref: "jti-1", ok: true, data: { pong: true } };
    await handleNodeMessage(h.deps, ws, JSON.stringify(ev));
    // The correlator receives THIS socket's record, not some registry-wide scan.
    const own = ws.data.nodeConn;
    if (!own) throw new Error("open must stash the registry record on ws.data");
    expect(h.results).toEqual([{ conn: own, event: ev }]);
    h.resultMiss = true;
    await handleNodeMessage(h.deps, ws, JSON.stringify({ ...ev, ref: "gone" }));
    expect(ws.closed).toHaveLength(0);
  });

  it("result on a socket whose node was superseded still settles only ITS own record", async () => {
    const h = makeHarness();
    const first = fakeSocket("n1");
    handleNodeOpen(first); // will be superseded, but its close hasn't fired
    const second = fakeSocket("n1");
    handleNodeOpen(second); // registry now maps the fresh record
    const ev: Extract<NodeEvent, { type: "result" }> = { type: "result", ref: "jti-x", ok: true };
    await handleNodeMessage(h.deps, first, JSON.stringify(ev));
    // The superseded socket's frame goes to the superseded record — the
    // replacement's pendings are structurally out of reach from this socket.
    const oldConn = first.data.nodeConn;
    if (!oldConn) throw new Error("open must stash the registry record on ws.data");
    expect(h.results).toEqual([{ conn: oldConn, event: ev }]);
    expect(h.results[0].conn).not.toBe(second.data.nodeConn);
  });

  it("phase-2 events and error frames are ingested without repo writes", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, JSON.stringify({ type: "exit", subshellId: "s", exitCode: 0, at: "now" }));
    await handleNodeMessage(
      h.deps,
      ws,
      JSON.stringify({ type: "subshells_report", subshells: [{ subshellId: "s", alive: true, exitCode: null }] }),
    );
    await handleNodeMessage(
      h.deps,
      ws,
      JSON.stringify({
        type: "output",
        subshellId: "s",
        subId: "t",
        fromByte: 0,
        toByte: 1,
        data_b64: "aGk=",
      }),
    );
    await handleNodeMessage(h.deps, ws, JSON.stringify({ type: "error", code: "disk", message: "full" }));
    expect(h.ready).toHaveLength(0);
    expect(h.touched).toHaveLength(0);
    expect(h.statuses).toHaveLength(0);
    expect(ws.closed).toHaveLength(0);
  });

  it("malformed or unrecognized frames are dropped silently", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, "not json at all");
    await handleNodeMessage(h.deps, ws, JSON.stringify({ type: "quantum_tunnel" }));
    expect(ws.closed).toHaveLength(0);
    expect(h.ready).toHaveLength(0);
  });

  it("oversized frames close 1009 — both as text and pre-parsed objects — with no processing", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, "x".repeat(NODE_MAX_FRAME_BYTES + 1));
    expect(ws.closed).toEqual([{ code: NODE_CLOSE_TOO_BIG, reason: expect.any(String) }]);
    const ws2 = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws2, { type: "heartbeat", ts: "y".repeat(NODE_MAX_FRAME_BYTES) });
    expect(ws2.closed.map((c) => c.code)).toEqual([NODE_CLOSE_TOO_BIG]);
    expect(h.touched).toHaveLength(0);
  });

  it("frames on a socket without identity are ignored entirely", async () => {
    const h = makeHarness();
    await handleNodeMessage(h.deps, fakeSocket(), JSON.stringify({ type: "heartbeat", ts: "now" }));
    expect(h.touched).toHaveLength(0);
  });
});

/* ---------------------------- close ----------------------------- */

describe("handleNodeClose (superseded-close hygiene, spec §5.3)", () => {
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("current socket dies → detach, offline projection", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeClose(h.deps, ws);
    expect(h.statuses).toEqual([{ id: "n1", status: "offline" }]);
    expect(getLive("n1")).toBeUndefined();
  });

  it("close fails the connection's in-flight commands as `offline`", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    const conn = ws.data.nodeConn;
    if (!conn) throw new Error("open must stash the registry record on ws.data");
    let rejected: unknown;
    conn.pending.set("jti-1", {
      resolve: () => {},
      reject: (err) => {
        rejected = err;
      },
      timer: setTimeout(() => {}, 5000),
    });
    await handleNodeClose(h.deps, ws);
    expect(rejected).toBeInstanceOf(NodeRpcError);
    expect((rejected as NodeRpcError).code).toBe("offline");
    expect(conn.pending.size).toBe(0);
  });

  it("SUPERSEDED socket's late close: fails only ITS pendings, never evicts or offlines the node", async () => {
    const h = makeHarness();
    const first = fakeSocket("n1");
    handleNodeOpen(first);
    const oldConn = first.data.nodeConn;
    if (!oldConn) throw new Error("open must stash the registry record on ws.data");
    let oldRejected = false;
    oldConn.pending.set("jti-old", {
      resolve: () => {},
      reject: () => {
        oldRejected = true;
      },
      timer: setTimeout(() => {}, 5000),
    });

    const second = fakeSocket("n1");
    handleNodeOpen(second); // newest-wins; the old socket was 4409'd
    const freshConn = second.data.nodeConn;
    if (!freshConn) throw new Error("open must stash the registry record on ws.data");
    let freshRejected = false;
    freshConn.pending.set("jti-fresh", {
      resolve: () => {},
      reject: () => {
        freshRejected = true;
      },
      timer: setTimeout(() => {}, 5000),
    });

    // The old socket's close event now fires — AFTER the replacement is mapped.
    await handleNodeClose(h.deps, first);

    expect(oldRejected).toBe(true); // its own commands die
    expect(freshRejected).toBe(false); // the new connection survives
    expect(getLive("n1")?.ws).toBe(second); // map untouched
    expect(h.statuses).toEqual([]); // node is NOT marked offline
    expect(second.closed).toHaveLength(0); // nobody closed the live socket

    // And the real close of the live socket still offlines it.
    await handleNodeClose(h.deps, second);
    expect(h.statuses).toEqual([{ id: "n1", status: "offline" }]);
    expect(getLive("n1")).toBeUndefined();
  });

  it("close of a socket that never attached is a no-op", async () => {
    const h = makeHarness();
    await handleNodeClose(h.deps, fakeSocket("n1"));
    expect(h.statuses).toEqual([]);
  });
});
