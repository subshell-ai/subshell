import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  MIN_NODE_VERSION,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
} from "@internal/subshell-protocol";
import { HttpError } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { type NodeReadyReport, NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { NodeKind, NodeTable } from "@/db/types/nodes.db-types.js";
import { subscribeLive } from "@/services/live-bus.js";
import { resetInputHoldsForTests } from "@/ws/input-hold.js";
import { resetInputWindowsForTests } from "@/ws/input-window.js";
import { handleSubshellMessage } from "@/ws/subshell-ws.js";
import { resetNodeEventsForTests, setNodeLifecycleHooks } from "../node-events.js";
import {
  attachConnection,
  disconnectNode,
  getHeld,
  getLive,
  isNodeOffline,
  listHeld,
  listOnline,
  type NodeConnection,
  OWNER_DISABLED_CLOSE_CODE,
  resetNodeRegistryForTests,
} from "../node-registry.js";
import { NodeRpcError } from "../node-rpc.js";
import {
  authenticateNodeUpgrade,
  frameBytes,
  handleNodeClose,
  handleNodeMessage,
  handleNodeOpen,
  NODE_CLOSE_TOO_BIG,
  NODE_CLOSE_UNAUTHENTICATED,
  type NodeWsDeps,
  type NodeWsSocket,
} from "../node-ws-handler.js";

/* ---------------------------- fakes ----------------------------- */

/**
 * `handleNodeOpen` grew the post-attach re-ask (the disable race — pinned in
 * its own describe below), so it now takes the account seam. Call sites that
 * invoke `open` only for its SYNCHRONOUS half — the `attachConnection` and
 * the stashed `ws.data.nodeConn` — use this seam: it answers "enabled", and
 * their fakes carry no stashed `ownerUserId`, so the re-ask is skipped and
 * the attach behaves exactly as it did before the race closed.
 */
const OPEN_DEPS: Pick<NodeWsDeps, "accountDisabled"> = { accountDisabled: async () => false };

/** Scripted socket: records sends (text OR binary) and closes, carries `data` like ElysiaWS. */
interface FakeNodeSocket extends NodeWsSocket {
  sent: Array<string | Buffer>;
  closed: { code?: number; reason?: string }[];
}

function fakeSocket(nodeId?: string): FakeNodeSocket {
  return {
    data: nodeId ? { nodeId, apiKeyId: "k-n1" } : {},
    sent: [],
    closed: [],
    send(d: string | Buffer) {
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
  /** node id → owner user id on the fake row (absent = "u-owner") */
  owners: Map<string, string>;
  /** user ids `deps.accountDisabled` answers disabled for */
  disabledOwners: Set<string>;
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
    owners: new Map(),
    disabledOwners: new Set(),
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
    accountDisabled: async (userId) => h.disabledOwners.has(userId),
    nodes: {
      findById: async (id) =>
        h.bindings.has(id)
          ? ({
              id,
              apiKeyId: h.bindings.get(id) ?? null,
              kind: h.kinds.get(id) ?? "agent",
              ownerUserId: h.owners.get(id) ?? "u-owner",
            } as unknown as NodeTable)
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
  agentVersion: MIN_NODE_VERSION,
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
    // The owner of the seeded `local` row is the system service user — and
    // the kind refusal must land BEFORE the owner check, so even answering
    // "disabled" for that owner leaves the LOCAL refusal as the one seen.
    const h = makeHarness();
    h.keys.set("local", { id: "k-local", metadata: { kind: "node", nodeId: "local" } });
    h.bindings.set("local", "k-local"); // key↔row link is CORRECT — only `kind` refuses
    h.kinds.set("local", "local");
    h.disabledOwners.add("u-owner"); // what the fake row names as local's owner
    await expect(authenticateNodeUpgrade(h.deps, "Bearer local")).rejects.toMatchObject({
      status: 403,
      message: "The local node cannot connect over /ws/node",
    });
  });

  it("refuses 403 when the node's owner account is disabled (ruling 2026-09-24)", async () => {
    // The key is fully live — rotate and delete own that tier — so the
    // ACCOUNT is the gate: a disabled person's enrolled nodes are offline,
    // and stay so until re-enabled.
    const h = makeHarness();
    h.keys.set("good", { id: "k1", metadata: { kind: "node", nodeId: "n1" } });
    h.bindings.set("n1", "k1");
    h.owners.set("n1", "u-bob");
    h.disabledOwners.add("u-bob");
    await expect(authenticateNodeUpgrade(h.deps, "Bearer good")).rejects.toMatchObject({
      status: 403,
      message: "The node's owner account is disabled",
    });

    // Re-enabling is the whole recovery: the agent's backoff loop re-dials on
    // its own, and the next attempt lands. No second act on the key.
    h.disabledOwners.delete("u-bob");
    await expect(authenticateNodeUpgrade(h.deps, "Bearer good")).resolves.toEqual({
      nodeId: "n1",
      apiKeyId: "k1",
      ownerUserId: "u-bob",
    });
  });

  it("accepts the fully linked chain and passes the RAW key (bearer prefix stripped) to the verifier", async () => {
    const h = makeHarness();
    h.keys.set("good", { id: "k1", metadata: { kind: "node", nodeId: "n1" } });
    h.bindings.set("n1", "k1");
    await expect(authenticateNodeUpgrade(h.deps, "Bearer good")).resolves.toEqual({
      nodeId: "n1",
      apiKeyId: "k1",
      ownerUserId: "u-owner",
    });
  });
});

/* ---------------------------- open ------------------------------ */

describe("handleNodeOpen", () => {
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("attaches the authenticated socket to the registry", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeOpen(h.deps, ws);
    expect(getLive("n1")?.ws).toBe(ws);
    expect(ws.data.nodeConn).toBe(getLive("n1"));
    // Open does NOT write — status flips online only with `ready`.
    expect(ws.closed).toHaveLength(0);
  });

  it("closes 4401 when no identity was stashed (never-authenticated socket)", async () => {
    const h = makeHarness();
    const ws = fakeSocket();
    await handleNodeOpen(h.deps, ws);
    expect(ws.closed).toEqual([{ code: NODE_CLOSE_UNAUTHENTICATED, reason: expect.any(String) }]);
    expect(getLive("n1")).toBeUndefined();
  });

  it("second attach supersedes the first with 4409 (registry semantics)", async () => {
    const h = makeHarness();
    const first = fakeSocket("n1");
    await handleNodeOpen(h.deps, first);
    const second = fakeSocket("n1");
    await handleNodeOpen(h.deps, second);
    expect(first.closed.map((c) => c.code)).toEqual([4409]);
    expect(getLive("n1")?.ws).toBe(second);
  });

  /**
   * FINDING: check-then-attach is inherently racy. The upgrade hook asks
   * `accountDisabled`, the disable route commits its flag and runs its sweep
   * (finding no live socket to close — this one has not attached yet), and
   * THEN `open` lands its `attachConnection`. Without a second ask after the
   * attach, that socket would stay online until the agent's own connection
   * happened to drop. The post-attach re-check closes the window: a disable
   * that beats the attach is caught by the sweep, one that lands inside it is
   * caught here.
   */
  it("a disable landing between the upgrade check and the attach evicts the socket", async () => {
    const h = makeHarness();
    h.keys.set("good", { id: "k1", metadata: { kind: "node", nodeId: "n1" } });
    h.bindings.set("n1", "k1");
    // The upgrade chain passes — the owner is enabled at check time. Its
    // stashed identity carries the owner id precisely so `open` can re-ask.
    const identity = await authenticateNodeUpgrade(h.deps, "Bearer good");
    expect(identity.ownerUserId).toBe("u-owner");

    // The disable commits, and its sweep runs — there is no socket yet.
    h.disabledOwners.add("u-owner");

    const ws = fakeSocket("n1");
    Object.assign(ws.data, identity);
    await handleNodeOpen(h.deps, ws);
    expect(ws.closed).toEqual([{ code: OWNER_DISABLED_CLOSE_CODE, reason: "the node's owner account is disabled" }]);
    // Evicted from the live registry, not merely closed — the sweep's own
    // contract (capture-then-evict-then-drain) applied by the same helper.
    expect(getLive("n1")).toBeUndefined();
  });

  it("an enabled owner answers the re-ask and the socket stays", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    ws.data.ownerUserId = "u-owner";
    await handleNodeOpen(h.deps, ws);
    expect(ws.closed).toHaveLength(0);
    expect(getLive("n1")?.ws).toBe(ws);
  });

  it("an owner-less identity (a fake that skipped the upgrade stash) attaches without a re-ask", async () => {
    // The re-ask exists for the stashed-upgrade path; a socket whose `data`
    // names no owner is nothing the disable rule can answer about, and open
    // must not invent a row read to find one.
    let asked = 0;
    const _h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeOpen(
      {
        accountDisabled: async () => {
          asked += 1;
          return false;
        },
      },
      ws,
    );
    expect(asked).toBe(0);
    expect(ws.closed).toHaveLength(0);
    expect(getLive("n1")?.ws).toBe(ws);
  });
});

/* -------------- eviction projection (the disconnectNode seam) ------------ */

describe("forced-eviction projection", () => {
  // The seam these cases drive is REAL — `disconnectNode` projects through
  // `node-presence-announce` straight onto the shared handle, which is the
  // point — so this describe is the file's one deliberate database guest:
  // migrations run here, and rows are created and dropped per case.
  beforeAll(async () => {
    await runMigrations();
  });
  beforeEach(() => {
    resetNodeRegistryForTests();
  });
  afterAll(() => {
    resetNodeRegistryForTests();
  });

  const mkNode = async (): Promise<string> => {
    const id = `evict-node-${crypto.randomUUID()}`;
    await new NodesRepository(db).create({ id, ownerUserId: "u-evict", name: id, kind: "agent", status: "online" });
    return id;
  };

  it("handleNodeOpen's post-attach eviction projects the row offline and announces its panes", async () => {
    // The race-closing eviction above used to close + evict ONLY: the row is
    // usually pre-`ready` and reads offline, so nothing LOOKED wrong — but a
    // node row can already read online from an EARLIER session's `ready`
    // while a fresh socket is mid-handshake, and then the sweep-missed
    // socket's eviction has a projection to correct after all. The seam
    // projects for every eviction, which makes that case hold.
    const id = await mkNode();
    const pane = await new SubshellsRepository(db).create({
      id: `evict-pane-${crypto.randomUUID()}`,
      userId: "u-evict",
      presetId: "p",
      harnessId: "shell",
      name: "evict-pane",
      workingDir: "/tmp",
      tmuxSocket: null,
      nodeId: id,
      status: "running",
    });
    const changed: string[] = [];
    const off = subscribeLive((e) => {
      if (e.kind === "subshell.changed") changed.push(e.id);
    });
    try {
      const h = makeHarness();
      h.disabledOwners.add("u-owner");
      const ws = fakeSocket(id);
      ws.data.ownerUserId = "u-owner";
      await handleNodeOpen(h.deps, ws);
      expect(ws.closed).toEqual([{ code: OWNER_DISABLED_CLOSE_CODE, reason: "the node's owner account is disabled" }]);
      expect(getLive(id)).toBeUndefined();
      // Awaited through `handleNodeOpen` by the seam: the write landed with
      // the call, not on a later sweep.
      expect((await new NodesRepository(db).findById(id))?.status).toBe("offline");
      await new Promise((r) => setTimeout(r, 20));
      expect(changed).toContain(pane.id);
      // And ONLY the seam projected: the handler injected nothing into its
      // own (fake) repo, so a second projection path there would double-fire.
      expect(h.statuses).toEqual([]);
    } finally {
      off();
      await db.deleteFrom("subshells").where("id", "=", pane.id).execute();
      await db.deleteFrom("nodes").where("id", "=", id).execute();
    }
  });

  it("an applyReady whose UPDATE lands after a forced eviction converges the row back to offline", async () => {
    // The C14 probe gates the frame when it STARTS; the race lives in the
    // await after it. A `disconnectNode` (rotate, delete, disable) can land
    // while this frame's applyReady UPDATE is in flight: the seam detaches
    // and projects `offline`, and the already-issued write lands `online` on
    // top of it — the row then reads online with no socket until the stale
    // sweep catches it ~45 s later. The gate is pinned here with a deferred
    // write against the REAL registry and the REAL projection seam: the
    // eviction completes fully before the UPDATE is allowed to land, so the
    // bad end-state is a certainty at that point, not a scheduling accident.
    const id = await mkNode();
    const repo = new NodesRepository(db);
    await repo.setStatus(id, "offline");
    const h = makeHarness();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => (releaseWrite = r));
    let writeStarted!: () => void;
    const started = new Promise<void>((r) => (writeStarted = r));
    h.deps.nodes.applyReady = async (nodeId, report) => {
      h.ready.push({ id: nodeId, report });
      writeStarted();
      await writeGate; // the UPDATE is "in flight" from here…
      return repo.applyReady(nodeId, report); // …until the gate opens
    };
    const ws = fakeSocket(id);
    await handleNodeOpen(OPEN_DEPS, ws);
    const frame = handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame()));
    await started;
    // Eviction completes while the write is still in flight.
    await expect(disconnectNode(id)).resolves.toBe(true);
    expect((await repo.findById(id))?.status).toBe("offline");
    // Land the stale UPDATE over it, then let the frame finish.
    releaseWrite();
    await frame;
    // The row ends offline: the handler's post-write identity probe saw its
    // own record gone and re-projected through the same seam (`h.statuses`
    // empty proves the fake repo was not asked — the projection is real).
    expect((await repo.findById(id))?.status).toBe("offline");
    expect(h.statuses).toEqual([]);
    await db.deleteFrom("nodes").where("id", "=", id).execute();
  });

  it("a late frame on a SUPERSEDED socket does not project the live replacement offline", async () => {
    // The convergence is directional. Gone means the eviction deserves the
    // last word; replaced means a NEWER socket is live and `online` is that
    // machine's honest state — projecting over it would strand a healthy
    // node offline until its next reconnect, the same row/registry
    // divergence wearing the other coat. Assert both halves of "the stale
    // frame does nothing to the replacement": no projection, and no machine
    // facts written onto the newer connection.
    const id = await mkNode();
    const repo = new NodesRepository(db);
    await repo.setStatus(id, "online");
    const h = makeHarness();
    const stale = fakeSocket(id);
    await handleNodeOpen(OPEN_DEPS, stale);
    const staleConn = getLive(id)!;
    const frame = handleNodeMessage(h.deps, stale, JSON.stringify(readyFrame()));
    // Re-dial mid-frame: newest-wins replaces the record (and closes the
    // stale socket with 4409).
    const replacement = fakeSocket();
    attachConnection(id, replacement);
    await frame;
    expect((await repo.findById(id))?.status).toBe("online");
    expect(h.statuses).toEqual([]);
    expect(getLive(id)!.agent).toBeUndefined();
    // The stale record was superseded (newest-wins closed its socket); the
    // replacement's record is untouched by the stale frame.
    expect(stale.closed[0]?.code).toBe(NODE_CLOSE_SUPERSEDED);
    expect(staleConn.agent).toBeUndefined();
    await db.deleteFrom("nodes").where("id", "=", id).execute();
  });

  it("the close event that lands AFTER a forced disconnect does not project again", async () => {
    // The eviction detaches before the socket's close lands, so the close
    // handler's identity guard correctly skips — the same guard that
    // defuses the re-attach race, now also what keeps a forced eviction's
    // projection single. Assert it directly: force-disconnect (seam writes
    // offline), restore the row to online by hand, deliver the late close,
    // and NOTHING touches the projection.
    const id = await mkNode();
    const sock = fakeSocket();
    attachConnection(id, sock);
    const conn = getLive(id)!;
    await expect(disconnectNode(id)).resolves.toBe(true);
    expect((await new NodesRepository(db).findById(id))?.status).toBe("offline");
    await new NodesRepository(db).setStatus(id, "online");

    const h = makeHarness();
    const closing = fakeSocket(id);
    closing.data.nodeConn = conn;
    await handleNodeClose(h.deps, closing);
    expect(h.statuses).toEqual([]);
    expect((await new NodesRepository(db).findById(id))?.status).toBe("online");
    await db.deleteFrom("nodes").where("id", "=", id).execute();
  });
});

/* --------------------------- message ---------------------------- */

describe("handleNodeMessage (inbound unsigned events, spec §3.3/§5.3)", () => {
  // The C14 live-path identity probe reads the registry, so every case needs
  // a clean map: an entry leaked from the `handleNodeOpen` describe above (or
  // a prior case's `handleNodeOpen`) would make the fakes that never opened a
  // socket look superseded-by-someone-else and drop their frames.
  beforeEach(() => {
    resetNodeRegistryForTests();
  });

  it("ready → applyReady with the mapped report; NO inventory pull follows (Task 7)", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame()));
    expect(h.ready).toEqual([
      {
        id: "n1",
        report: {
          agentVersion: MIN_NODE_VERSION,
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
      handleNodeOpen(OPEN_DEPS, ws);
      await handleNodeMessage(h.deps, ws, JSON.stringify(readyFrame({ agentVersion: "0.0.1" })));
      expect(getHeld("n1")).toBeDefined();
      expect(h.detects).toEqual([]);
    });

    it("a ready HELD on a protocol mismatch kicks nothing, and neither does its reconnect", async () => {
      const h = makeHarness();
      const ws = fakeSocket("n1");
      handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, ws2);
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
    handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(h.statuses).toEqual([{ id: "n1", status: "offline" }]);
  });

  it("ready at the agent floor → accepted, and nothing is held", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, ws);
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: MIN_NODE_VERSION }));
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
    handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, ws);
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
      handleNodeOpen(OPEN_DEPS, ws);
      await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "99.0.0", protocolVersion }));
      expect(ws.closed).toHaveLength(0);
      expect(getHeld("n1")).toMatchObject({ reason: "protocol-mismatch", protocolVersion });
    }
  });

  it("closes 4406 the old way when there is no connection record to hold", async () => {
    // A socket that never went through `open` has nothing to put in the held
    // map. Refusing it the old way is better than leaving it attached to
    // nothing, and the reason string is the one the agent relays to its log.
    const h = makeHarness();
    const ws = fakeSocket("n1"); // deliberately NOT opened
    await handleNodeMessage(h.deps, ws, readyFrame({ agentVersion: "0.0.1" }));
    expect(ws.closed[0]?.code).toBe(NODE_CLOSE_UPDATE_REQUIRED);
    expect(ws.closed[0]?.reason).toContain(MIN_NODE_VERSION);
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
    handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, first);
    await handleNodeMessage(h.deps, first, readyFrame({ agentVersion: "0.0.1" }));
    expect(getHeld("n1")).toBeDefined();

    const second = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, second);
    expect(first.closed[0]?.code).toBe(NODE_CLOSE_SUPERSEDED);
    expect(getHeld("n1")).toBeUndefined();
    await handleNodeMessage(h.deps, second, readyFrame());
    expect(getLive("n1")).toBeDefined();
  });

  it("releases the held entry when its socket closes", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, ws); // stashes ws.data.nodeConn — the connection-scoping anchor
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

  it("a superseded socket cannot queue stale row writes (C14 live-path identity)", async () => {
    // The twin of the held path's identity probe. A replacement flips the
    // registry map immediately; the old socket's close lands whenever Elysia
    // gets to it, and any frame already chained on THAT socket's queue would
    // otherwise apply `ready`/`heartbeat` writes for a connection the plane
    // has already disowned. This pins the refusal (no repo write from A), and
    // pins that B — the current record — is untouched.
    const h = makeHarness();
    const first = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, first);
    const second = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, second); // newest-wins: first is closed 4409, close not yet run
    await handleNodeMessage(h.deps, first, JSON.stringify(readyFrame()));
    await handleNodeMessage(h.deps, first, JSON.stringify({ type: "heartbeat", ts: "now" }));
    expect(h.ready).toHaveLength(0);
    expect(h.touched).toEqual([]);

    // The replacement's own frames land normally.
    await handleNodeMessage(h.deps, second, JSON.stringify(readyFrame()));
    expect(h.ready).toHaveLength(1);
  });

  it("result on a socket whose node was superseded still settles only ITS own record", async () => {
    const h = makeHarness();
    const first = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, first); // will be superseded, but its close hasn't fired
    const second = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, second); // registry now maps the fresh record
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

  it("oversized frames close 1009 — text, pre-parsed objects, AND binary — with no processing", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, "x".repeat(NODE_MAX_FRAME_BYTES + 1));
    expect(ws.closed).toEqual([{ code: NODE_CLOSE_TOO_BIG, reason: expect.any(String) }]);
    const ws2 = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws2, { type: "heartbeat", ts: "y".repeat(NODE_MAX_FRAME_BYTES) });
    expect(ws2.closed.map((c) => c.code)).toEqual([NODE_CLOSE_TOO_BIG]);
    // The binary arm (task 6 plumbing; Task 8's ciphertext cap stands on it):
    // one byte over the cap closes, measured NATIVELY per ruling R2.
    const ws3 = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws3, new Uint8Array(NODE_MAX_FRAME_BYTES + 1));
    expect(ws3.closed.map((c) => c.code)).toEqual([NODE_CLOSE_TOO_BIG]);
    expect(h.touched).toHaveLength(0);
  });

  it("a binary frame under the cap reaches dispatch and is dropped unrecognized, not closed", async () => {
    // Pre-R2 this closed 1009: the JSON.stringify branch measured a Buffer at
    // its `{"type":"Buffer","data":[…]}` length, ~4× over the real byte size.
    const h = makeHarness();
    const ws = fakeSocket("n1");
    await handleNodeMessage(h.deps, ws, Buffer.alloc(NODE_MAX_FRAME_BYTES - 1024, 7));
    expect(ws.closed).toHaveLength(0);
    expect(h.touched).toHaveLength(0);
    expect(h.ready).toHaveLength(0);
  });

  it("frames on a socket without identity are ignored entirely", async () => {
    const h = makeHarness();
    await handleNodeMessage(h.deps, fakeSocket(), JSON.stringify({ type: "heartbeat", ts: "now" }));
    expect(h.touched).toHaveLength(0);
  });
});

/* ---------------------------- frameBytes ----------------------------- */

/**
 * Ruling R2 (spec 2026-09-24 ledger): binary ciphertext frames must measure at
 * their native byte size. The old `Buffer.byteLength(JSON.stringify(raw))`
 * fallback serialized a Buffer to `{"type":"Buffer","data":[1,2,…]}` — an
 * order of magnitude over its real size — so every encrypted frame would read
 * oversize and close 1009. Task 8's pre-decrypt ciphertext cap depends on
 * what these shapes measure.
 */
describe("frameBytes (ruling R2 — binary measures natively)", () => {
  it("measures a Buffer by its bytes, not its JSON serialization", () => {
    const raw = Buffer.alloc(100, 7);
    expect(frameBytes(raw)).toBe(100);
    // The bug this pins: the JSON fallback is many times larger.
    expect(frameBytes(raw)).toBeLessThan(Buffer.byteLength(JSON.stringify(raw)));
  });

  it("measures a Uint8Array by its own view window, not its backing store", () => {
    const backing = new Uint8Array(64);
    const view = backing.subarray(8, 18);
    expect(frameBytes(view)).toBe(10);
  });

  it("measures an ArrayBuffer by byteLength", () => {
    expect(frameBytes(new ArrayBuffer(77))).toBe(77);
  });

  it("keeps the JSON branch for genuinely-parsed objects", () => {
    const parsed = { type: "heartbeat", ts: "2026-09-24T00:00:00Z" };
    expect(frameBytes(parsed)).toBe(Buffer.byteLength(JSON.stringify(parsed)));
  });

  it("measures strings as UTF-8 bytes", () => {
    expect(frameBytes("héllo")).toBe(6);
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
    handleNodeOpen(OPEN_DEPS, ws);
    await handleNodeClose(h.deps, ws);
    expect(h.statuses).toEqual([{ id: "n1", status: "offline" }]);
    expect(getLive("n1")).toBeUndefined();
  });

  it("close fails the connection's in-flight commands as `offline`", async () => {
    const h = makeHarness();
    const ws = fakeSocket("n1");
    handleNodeOpen(OPEN_DEPS, ws);
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
    handleNodeOpen(OPEN_DEPS, first);
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
    handleNodeOpen(OPEN_DEPS, second); // newest-wins; the old socket was 4409'd
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

/**
 * Wave D wiring (spec 2026-09-21): a node's `ready` moment is one of the two
 * re-fire triggers for held plane→node input writes (`ws/input-hold.ts`).
 * The hold is seeded through the real message handler against a fabricated
 * browser session, then the node socket's ready is driven through the real
 * handler — the seam under test is the CALL, not the hold's own math (that
 * is pinned in ws/__tests__/input-hold.test.ts).
 */
describe("ready → the input-hold re-fire (Wave D)", () => {
  /**
   * A fabricated attached browser session. The launcher REJECTS every write
   * until `go()` swaps it for a recording stub — the re-fire reads the
   * launcher off ws.data at write time, so the swap is how a recovered node
   * ships.
   */
  function heldSession(subshellId: string) {
    const inputs: string[] = [];
    let go = false;
    const launcher = {
      sendInput: async (_socket: string, _id: string, input: string) => {
        if (!go) throw new Error("node n1 has no live connection");
        inputs.push(input);
      },
      resize: async () => undefined,
      paneSize: async () => null,
    } as unknown as Parameters<typeof handleSubshellMessage>[0]["data"]["launcher"];
    const ws = {
      data: {
        launcher,
        socket: "sock",
        subshellId,
        nodeId: "n1",
        logFile: "",
        canInput: true,
        viewerId: crypto.randomUUID(),
        deviceLabel: "Test device",
        since: new Date().toISOString(),
        query: { sid: "sess-r" },
      },
      send: () => 0,
      close: () => undefined,
    } as unknown as Parameters<typeof handleSubshellMessage>[0];
    return {
      ws,
      inputs,
      /** Arms the launcher so re-fired writes land. */
      go: () => {
        go = true;
      },
      type: (data: string, id: number) => handleSubshellMessage(ws, JSON.stringify({ type: "input", data, id })),
    };
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    resetInputHoldsForTests();
    resetInputWindowsForTests();
  });

  it("an accepted ready re-fires the node's held writes", async () => {
    const h = makeHarness();
    const s = heldSession("s-refire");
    s.type("k", 1);
    await settle();
    expect(s.inputs).toEqual([]); // held, node down
    s.go();
    await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify(readyFrame()));
    await settle();
    expect(s.inputs).toEqual(["k"]); // re-fired by the ready, once
  });

  it("a ready HELD below the version floor re-fires nothing", async () => {
    // A held agent is offline for every purpose but `update` — the same rule
    // that keeps the detection kick off it keeps the re-fire off it too.
    const h = makeHarness();
    const s = heldSession("s-refire-held");
    s.type("k", 1);
    await settle();
    expect(s.inputs).toEqual([]);
    s.go();
    await handleNodeMessage(h.deps, fakeSocket("n1"), JSON.stringify(readyFrame({ agentVersion: "0.0.1" })));
    await settle();
    expect(s.inputs).toEqual([]); // still held, still waiting
  });
});
