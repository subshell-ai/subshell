import { beforeEach, describe, expect, it } from "bun:test";
import {
  MIN_AGENT_VERSION,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
} from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import type { NodeReadyReport } from "@/db/repositories/nodes.repository.js";
import type { NodeKind, NodeTable } from "@/db/types/nodes.db-types.js";
import { resetNodeEventsForTests, setNodeLifecycleHooks } from "../node-events.js";
import {
  getHeld,
  getLive,
  isNodeOffline,
  listHeld,
  listOnline,
  type NodeConnection,
  resetNodeRegistryForTests,
} from "../node-registry.js";
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
  /** when set, deps.resolveResult returns false instead of true */
  resultMiss: boolean;
  /** node ids the connect-time detection kick was handed, in order */
  detects: string[];
  /** when set, deps.detect throws instead of recording */
  detectThrows: boolean;
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
    resultMiss: false,
    detects: [],
    detectThrows: false,
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
    // Seamed in every test, so no case in this file reaches the real driver
    // (which would open the database to look a node up) merely by handling a
    // `ready` frame.
    detect: (nodeId) => {
      if (h.detectThrows) throw new Error(`detect seam blew up for ${nodeId}`);
      h.detects.push(nodeId);
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
  it("ready → applyReady with the mapped report; NO inventory pull follows (Task 7)", async () => {
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
    // Task 7 retired the §5.3 pull: a post-inversion agent answers the
    // `inventory` command with an EMPTY harness claim the handler refuses to
    // apply, so `ready` must not send it — freshness rides the
    // request-driven detect path instead (remote-launcher's kick, page
    // load, Re-check). The pull had a dedicated `requestInventory` dep until
    // this commit; its removal from {@link NodeWsDeps} is itself the pin that
    // `ready` cannot pull anymore, whatever a future frame handler grows.
    expect(ws.closed).toHaveLength(0);
  });

  /**
   * Harness detection when a node comes ONLINE — the half of freshness a
   * person cannot supply (spec 2026-09-10 §4 as extended; the periodic other
   * half is `services/nodes/inventory-refresh.ts`).
   *
   * Not the §5.3 inventory PULL Task 7 retired: that asked the agent to scan
   * ITSELF. This is the ordinary §4 request — the plane ships its detect
   * rules, the node answers — fired because becoming reachable is an occasion
   * to ask. A freshly enrolled agent connects the moment it is installed, so
   * enrolment needs no special case here, and every reconnect is covered by
   * the same line.
   */
  describe("ready → the connect-time detection kick", () => {
    it("an accepted ready kicks detection exactly ONCE, for its own socket's node", async () => {
      const h = makeHarness();
      const ws = fakeSocket("n1");
      await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame()));
      expect(h.detects).toEqual(["n1"]);
    });

    it("the id kicked is the SOCKET's, never one the frame claims", async () => {
      // Same rule the `exit` case states out loud: a frame-supplied nodeId is
      // ignored. A node that could name another node here would aim this
      // plane's probes at a machine it was not talking to.
      const h = makeHarness();
      const ws = fakeSocket("n1");
      await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame({ nodeId: "n-someone-else" })));
      expect(h.detects).toEqual(["n1"]);
    });

    it("every reconnect kicks again — one per ready, not one per node", async () => {
      const h = makeHarness();
      await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify(readyFrame()));
      await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify(readyFrame()));
      expect(h.detects).toEqual(["n1", "n1"]);
    });

    it("a ready HELD below the version floor kicks nothing", async () => {
      // A held agent is offline for every purpose but `update`. Probing it
      // would be sending a command whose wire shape the two ends do not share.
      const h = makeHarness();
      const ws = fakeSocket("n1");
      handleNodeOpen(ws);
      await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame({ agentVersion: "0.0.1" })));
      expect(getHeld("n1")).toBeDefined();
      expect(h.detects).toEqual([]);
    });

    it("a ready HELD on a protocol mismatch kicks nothing, and neither does its reconnect", async () => {
      const h = makeHarness();
      const ws = fakeSocket("n1");
      handleNodeOpen(ws);
      await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame({ protocolVersion: 999 })));
      expect(h.detects).toEqual([]);
      // The reconnect `ready` from the SAME held socket is dropped before the
      // switch, so it cannot reach the kick either.
      await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame({ protocolVersion: 999 })));
      expect(h.detects).toEqual([]);
    });

    it("a kick that throws does not kill the handshake: maintenance still reconciles", async () => {
      // The real `detectOnNodeBestEffort` cannot throw — it absorbs everything
      // into a debug line. This pins the guard around a future seam that can:
      // the maintenance reconcile below the kick is load-bearing (the row must
      // refuse launches before this frame is done), so a probe must never be
      // the reason it did not run.
      const h = makeHarness();
      h.detectThrows = true;
      const seen: [string, unknown][] = [];
      setNodeLifecycleHooks({
        onExit: () => {},
        onSubshellsReport: () => {},
        onMaintenance: (nodeId, reported) => {
          seen.push([nodeId, reported]);
        },
      });
      try {
        const ws = fakeSocket("n1");
        await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame()));
        expect(h.ready).toHaveLength(1);
        expect(seen).toHaveLength(1);
        expect(ws.closed).toHaveLength(0);
      } finally {
        resetNodeEventsForTests();
      }
    });

    it("`local` can never reach this kick: the upgrade refuses its dial-in", async () => {
      // The kick is handed the socket's node id, and `local` never gets a
      // socket. The driver refuses it a second time on its own
      // (`inventory.ts`: local's view probes live on every read) — pinned in
      // `inventory-detect.test.ts`, "local is never sent a detect".
      const h = makeHarness();
      h.keys.set("local", { id: "k-local", metadata: { kind: "node", nodeId: "local" } });
      h.bindings.set("local", "k-local");
      h.kinds.set("local", "local");
      await expect(authenticateNodeUpgrade(h.deps, "Bearer local")).rejects.toMatchObject({ status: 403 });
      expect(h.detects).toEqual([]);
    });

    it("no other inbound frame kicks — heartbeat and inventory are not occasions to ask", async () => {
      const h = makeHarness();
      const ws = fakeSocket("n1");
      await handleNodeMessage(h.deps, ws, JSON.stringify({ type: "heartbeat", ts: new Date().toISOString() }));
      await handleNodeMessage(
        h.deps,
        ws,
        JSON.stringify({ type: "inventory", harnesses: [], ts: new Date().toISOString() }),
      );
      expect(h.detects).toEqual([]);
    });
  });

  /**
   * Maintenance reaches the service layer through the lifecycle HOOK, not
   * through a wider node-repository `Pick` — which is what keeps every fake
   * in this file satisfiable by hand. Both frames that can carry it call the
   * same hook: a flip discovered at connect and one reported mid-session are
   * the same disagreement, and one reconciler is what stops them answering
   * differently.
   */
  describe("maintenance → the lifecycle hook (spec 2026-09-14 §5.3)", () => {
    /** Install a recording hook and return both the log and the uninstaller. */
    function recordMaintenance(): { seen: [string, unknown][]; off: () => void } {
      const seen: [string, unknown][] = [];
      setNodeLifecycleHooks({
        onExit: () => {},
        onSubshellsReport: () => {},
        onMaintenance: (nodeId, reported) => {
          seen.push([nodeId, reported]);
        },
      });
      return { seen, off: () => resetNodeEventsForTests() };
    }

    it("a ready CARRYING maintenance reconciles it", async () => {
      const { seen, off } = recordMaintenance();
      try {
        const h = makeHarness();
        await handleNodeMessage(
          h.deps,
          fakeSocket("n1"),
          JSON.stringify(readyFrame({ maintenance: { on: true, changedAt: "2026-09-14T10:00:00.000Z" } })),
        );
        expect(seen).toEqual([["n1", { on: true, changedAt: "2026-09-14T10:00:00.000Z" }]]);
      } finally {
        off();
      }
    });

    it("a ready WITHOUT it still reconciles — 'the node has no file' is a fact, not a silence", async () => {
      // The plane may hold a window this machine never learned about (flipped
      // while it was offline, or its data dir wiped). Skipping the hook when
      // the field is absent would leave those two copies apart forever.
      const { seen, off } = recordMaintenance();
      try {
        const h = makeHarness();
        await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify(readyFrame()));
        expect(seen).toEqual([["n1", undefined]]);
      } finally {
        off();
      }
    });

    it("the maintenance EVENT reaches the same hook, under the SOCKET's nodeId", async () => {
      const { seen, off } = recordMaintenance();
      try {
        const h = makeHarness();
        await handleNodeMessage(
          h.deps,
          fakeSocket("n1"),
          JSON.stringify({ type: "maintenance", on: false, changedAt: "2026-09-14T11:00:00.000Z" }),
        );
        expect(seen).toEqual([["n1", { on: false, changedAt: "2026-09-14T11:00:00.000Z" }]]);
      } finally {
        off();
      }
    });

    it("a ready whose maintenance field is malformed keeps the ready and drops the field", async () => {
      // The lenient parse (protocol §3): an agent's bad optional must not cost
      // the plane the machine's identity, which is what `ready` is for.
      const { seen, off } = recordMaintenance();
      try {
        const h = makeHarness();
        await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify(readyFrame({ maintenance: { on: "yes" } })));
        expect(h.ready).toHaveLength(1);
        expect(seen).toEqual([["n1", undefined]]);
      } finally {
        off();
      }
    });
  });

  it("ready stashes homeDir and selfInvoke on the live facts; env is NOT a ready field", async () => {
    // Spec 2026-09-10 §5 as amended by the final review: `ready` reports the
    // home (resume defaults hang off it) and the agent's `selfInvoke`
    // self-invocation; the env VALUES answer on the `detect` round trip,
    // whose driver stashes them (inventory.ts). The "no env yet" branch is
    // the ordinary state between a connect and the first detect, and
    // `canResume` computes the plugin's default path for it.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(
      h.deps,
      ws,
      readyFrame({
        homeDir: "/home/n",
        selfInvoke: { command: "/usr/bin/subshell", args: [] },
        // A frame still bearing the dead field must not resurrect it on the
        // facts: the handler reads named fields, not the raw object.
        env: { CLAUDE_CONFIG_DIR: "/custom" },
      } as never),
    );
    const f = getLive("n1")?.agent;
    expect(f).toMatchObject({ homeDir: "/home/n", selfInvoke: { command: "/usr/bin/subshell", args: [] } });
    expect(f).not.toHaveProperty("env");

    const h2 = makeHarness();
    const ws2 = fakeSocket("n2");
    handleNodeOpen(ws2);
    await handleNodeMessage(h2.deps, ws2, readyFrame());
    const plain = getLive("n2")?.agent;
    expect(plain).toMatchObject({ hostname: "box" });
    expect(plain).not.toHaveProperty("homeDir");
    expect(plain).not.toHaveProperty("selfInvoke");
    expect(plain).not.toHaveProperty("env");
  });

  it("ready with a foreign protocol → recorded FIRST, then HELD rather than closed", async () => {
    // The refusal is unchanged; what changed (spec 2026-09-15 §5.3) is that
    // the socket stays open for one command instead of being dropped.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ protocolVersion: 999 }));
    expect(h.ready).toHaveLength(1); // persisted so the UI can say "agent too old"
    expect(ws.closed).toHaveLength(0);
    expect(getHeld("n1")).toMatchObject({ reason: "protocol-mismatch", protocolVersion: 999 });
    // And OFFLINE for everything else: it left the live registry, so the
    // blessed liveness predicate is unmoved by the hold existing.
    expect(getLive("n1")).toBeUndefined();
    expect(isNodeOffline("n1")).toBe(true);
    expect(listOnline()).not.toContain("n1");
  });

  it("writes the row back to OFFLINE, because applyReady set it online and nothing closes now", async () => {
    // The line the hold cannot do without. `applyReady` flips `status` to
    // online — deliberately, it is what persists the identity a page needs —
    // and before the hold the close path projected `offline` a moment later.
    // A held socket never closes, so without this the row reads online for a
    // machine no command can reach.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(h.statuses).toEqual([{ id: "n1", status: "offline" }]);
  });

  it("ready at the agent floor → accepted, and nothing is held", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: MIN_AGENT_VERSION }));
    expect(ws.closed).toHaveLength(0);
    expect(getHeld("n1")).toBeUndefined();
    expect(getLive("n1")).toBeDefined();
  });

  it("holds an agent below the floor, recording BOTH versions for the page", async () => {
    // The floor's whole point over a bare protocol number: the operator is
    // told what to install and what they are running. That now reaches them
    // through `listHeld`/the node view rather than only through a close
    // reason nobody sees until they read the agent's own log.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(ws.closed).toHaveLength(0);
    expect(getHeld("n1")).toMatchObject({ reason: "below-floor", agentVersion: "0.0.1" });
    expect(listHeld()).toEqual([
      expect.objectContaining({ nodeId: "n1", reason: "below-floor", agentVersion: "0.0.1", os: "linux", arch: "x64" }),
    ]);
  });

  it("holds an agent that cannot say what version it is", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "" }));
    expect(getHeld("n1")).toMatchObject({ reason: "below-floor", agentVersion: "" });
  });

  it("keeps the protocol check as a backstop, in BOTH directions", async () => {
    // Unreachable if the floor is set right — an agent above the floor ships
    // the current protocol — so this fires only when the floor itself is
    // wrong. Both directions matter: a `>=` slipping into the comparison
    // would let a behind-protocol agent through with a green suite.
    for (const protocolVersion of [NODE_PROTOCOL_VERSION + 1, NODE_PROTOCOL_VERSION - 1]) {
      resetNodeRegistryForTests();
      const h = makeHarness();
      const ws = fakeSocket("n1");
      handleNodeOpen(ws);
      await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "99.0.0", protocolVersion }));
      expect(ws.closed).toHaveLength(0);
      expect(getHeld("n1")).toMatchObject({ reason: "protocol-mismatch", protocolVersion });
    }
  });

  it("closes 4406 the old way when there is no connection record to hold", async () => {
    // A socket that never went through `open` has nothing to put in the held
    // map. Refusing it the old way is better than leaving it attached to
    // nothing, and the reason string is the one the agent relays to its log.
    resetNodeRegistryForTests(); // the backstop loop above leaves n1 held
    const h = makeHarness();
    const ws = fakeSocket("n1"); // deliberately NOT opened
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0]?.reason).toContain(MIN_AGENT_VERSION);
    expect(ws.closed[0]?.reason).toContain("0.0.1");
    expect(getHeld("n1")).toBeUndefined();
  });

  it("drops EVERY frame from a held socket except `result`", async () => {
    // A held agent speaks a protocol this server does not, so its claims are
    // about a contract the two ends do not share. It keeps sending them — its
    // heartbeat does not know it is being ignored — and dropping them costs
    // one map probe. The `result` exception is the whole point of holding.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    const readyCount = h.ready.length;

    await handleNodeMessage(h.deps, ws, JSON.stringify({ type: "heartbeat", ts: "now" }));
    await handleNodeMessage(
      h.deps,
      ws,
      JSON.stringify({ type: "inventory", ts: "now", harnesses: [{ harnessId: "claude", installed: true }] }),
    );
    await handleNodeMessage(
      h.deps,
      ws,
      JSON.stringify({ type: "maintenance", on: true, changedAt: "2026-09-15T00:00:00.000Z" }),
    );
    // The RECONNECT `ready` lands here too, and must not re-run applyReady —
    // that would flip the row back to online for an unreachable machine.
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(h.touched).toEqual([]);
    expect(h.inventories).toEqual([]);
    expect(h.ready).toHaveLength(readyCount);

    await handleNodeMessage(h.deps, ws, JSON.stringify({ type: "result", ref: "j1", ok: true }));
    expect(h.results).toHaveLength(1);
    expect(h.results[0]?.conn).toBe(getHeld("n1")?.conn as NodeConnection);
  });

  it("a second socket for the same node supersedes the held one", async () => {
    // Newest-wins is the same rule whichever map the socket is in, and the
    // commonest way it fires is the good one: an agent that was just updated
    // dialing back on the new binary.
    const h = makeHarness();
    const first = fakeSocket("n1");
    handleNodeOpen(first);
    await handleNodeMessage(h.deps, first, readyFrame({ agentVersion: "0.0.1" }));
    expect(getHeld("n1")).toBeDefined();

    const second = fakeSocket("n1");
    handleNodeOpen(second);
    expect(first.closed[0]?.code).toBe(NODE_CLOSE_SUPERSEDED);
    expect(getHeld("n1")).toBeUndefined();
    await handleNodeMessage(h.deps, second, readyFrame());
    expect(getLive("n1")).toBeDefined();
  });

  it("releases the held entry when its socket closes", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(getHeld("n1")).toBeDefined();
    await handleNodeClose(h.deps, ws);
    expect(getHeld("n1")).toBeUndefined();
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

  it("an EMPTY inventory harness list (the plugin-less agent's filler) does NOT reach applyInventory", async () => {
    // Task 7 (inversion §6): a node with no plugin concept still owes the v2
    // wire a `harnesses` array and fills it with `[]` on the connect push and
    // every 5-min beat. `[]` is "nothing to claim", not "nothing installed":
    // applying it would wipe the plane's own detect-cached rows (§4). The
    // cache-level proof lives in inventory-detect.test.ts; this pins that the
    // handler is where the claim dies, and that a NON-empty scan from a paired
    // pre-inversion agent still applies verbatim (the guard never grew teeth
    // the other way).
    const h = makeHarness();
    await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify({ type: "inventory", harnesses: [], ts: "now" }));
    expect(h.inventories).toEqual([]);
  });

  it("an inventory event records NO plugin declaration — `plugins` left the wire (protocol 3)", async () => {
    // Protocol 3 removed the field from the event type: the node holds no
    // plugins and reports none. The write target followed it — migration
    // 0026 dropped `nodes.plugins_json`/`plugins_at`, so even a stale frame
    // that still carries the key has nowhere to land: the repo slice the
    // socket holds has no plugin-report method to re-grow, and the handler
    // neither crashes nor invents one. The harness-scan half of the event is
    // unchanged.
    const h = makeHarness();
    // The stub carries exactly the repo slice `NodeWsNodesRepo` now names —
    // a handler reaching for a dead writer would be a type error AND a
    // runtime TypeError here, not a silent mirror write.
    await handleNodeMessage(
      h.deps,
      fakeSocket("n1"),
      JSON.stringify({
        type: "inventory",
        harnesses: [{ harnessId: "pi", installed: false, reason: "not-on-path" }],
        ts: "now",
      }),
    );
    expect(h.inventories).toHaveLength(1); // the scan still applies
    await handleNodeMessage(
      h.deps,
      fakeSocket("n1"),
      JSON.stringify({ type: "inventory", harnesses: [], plugins: [], ts: "now" }),
    );
    expect(h.inventories).toHaveLength(1); // the empty harness claim still dies at the guard
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
