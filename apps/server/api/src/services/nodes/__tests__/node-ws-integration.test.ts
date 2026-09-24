import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MIN_NODE_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { Elysia } from "elysia";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { getLive, resetNodeRegistryForTests } from "../node-registry.js";
import {
  authenticateNodeUpgrade,
  handleNodeClose,
  handleNodeMessage,
  handleNodeOpen,
  type NodeWsDeps,
  type NodeWsSocket,
} from "../node-ws-handler.js";

/**
 * `/ws/node` through the REAL Elysia ws stack (spec §5.3 spike made concrete):
 * the same hook wiring `ws.plugin.ts` installs, with only the deps swapped —
 * fake key store, real `nodes` rows in the shared temp DB. Proves the three
 * platform assumptions the handler depends on: throwing from `upgrade`
 * refuses the handshake pre-socket, the stashed identity reaches `ws.data`,
 * and open/message/close dispatch drives the row's status projection.
 */

const salt = Math.random().toString(36).slice(2, 8);
let seq = 0;
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

const nodes = new NodesRepository(db);

// raw bearer key → bound (apiKeyId, nodeId) — the fake better-auth store.
const keyStore = new Map<string, { id: string; nodeId: string }>();
/** user ids answered as disabled (ruling 2026-09-24, the /ws/node half). */
const disabledOwners = new Set<string>();

const deps: NodeWsDeps = {
  verifyApiKey: async (rawKey) => {
    const row = keyStore.get(rawKey);
    return row ? { id: row.id, metadata: { kind: "node", nodeId: row.nodeId } } : null;
  },
  nodes,
  accountDisabled: async (userId) => disabledOwners.has(userId),
  resolveResult: () => false, // no RPC in flight in this test
};

const app = new Elysia()
  // THE REAL global error handler — the refusal body the wire test below
  // asserts is exactly what production sends for a status-carrying throw.
  .use(errorHandlerPlugin)
  .ws("/ws/node", {
    async upgrade(context) {
      const request = (context as { request: Request }).request;
      const identity = await authenticateNodeUpgrade(deps, request.headers.get("authorization"));
      Object.assign(context as Record<string, unknown>, identity);
    },
    open(ws) {
      // `attachConnection` still lands synchronously (before the first await);
      // the async tail is the post-attach owner re-check (the disable race).
      void handleNodeOpen(deps, ws as unknown as NodeWsSocket);
    },
    message(ws, message) {
      if (typeof message === "string" || (message && typeof message === "object")) {
        void handleNodeMessage(deps, ws as unknown as NodeWsSocket, message as string | object);
      }
    },
    close(ws) {
      void handleNodeClose(deps, ws as unknown as NodeWsSocket);
    },
  })
  .listen(0);

const port = () => app.server?.port as number;

async function waitFor(cond: () => Promise<boolean> | boolean, what: string, budgetMs = 4000): Promise<void> {
  for (let waited = 0; ; waited += 20) {
    if (await cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Open a client socket; resolves on `open`, rejects on handshake failure. */
function connect(header: string | null): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port()}/ws/node`,
      header ? { headers: { Authorization: header } } : undefined,
    );
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("handshake refused")), { once: true });
  });
}

/**
 * A raw WS upgrade attempt over plain HTTP — a browser `WebSocket` hides the
 * refusal response, this exposes it: status line AND the error body the
 * server wrote pre-socket.
 */
function rawHandshake(header: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": Buffer.from(crypto.randomUUID()).toString("base64"),
    "sec-websocket-version": "13",
  };
  if (header) headers.authorization = header;
  return fetch(`http://localhost:${port()}/ws/node`, { headers });
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  app.server?.stop(true);
  resetNodeRegistryForTests();
});

describe("/ws/node over the real ws stack", () => {
  it("a bad key never gets a socket (handshake refused)", async () => {
    await expect(connect("Bearer nope")).rejects.toThrow("handshake refused");
    await expect(connect(null)).rejects.toThrow("handshake refused");
  });

  it("wire-level 401: refusal carries the real error body, not just a closed socket", async () => {
    // The client-side error event above proves "no socket"; this proves WHAT
    // the peer received pre-socket: 401 + INVALID_CREDENTIALS (spec §5.3),
    // produced by the REAL errorHandlerPlugin from the upgrade-hook throw.
    const res = await rawHandshake("Bearer nope");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; statusCode?: number };
    expect(body.code).toBe("INVALID_CREDENTIALS");
    expect(body.statusCode).toBe(401);

    const missing = await rawHandshake(null);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { code?: string }).code).toBe("INVALID_CREDENTIALS");
  });

  it("full lifecycle: authed open → ready marks online → close marks offline", async () => {
    const nodeId = unique("n");
    const apiKeyId = unique("k");
    const key = unique("secret");
    await nodes.create({
      id: nodeId,
      ownerUserId: unique("u"),
      name: unique("node"),
      kind: "agent",
      status: "offline",
    });
    await nodes.setApiKeyId(nodeId, apiKeyId);
    keyStore.set(key, { id: apiKeyId, nodeId });

    const ws = await connect(`Bearer ${key}`);
    await waitFor(() => getLive(nodeId)?.ws !== undefined, "registry attach");

    ws.send(
      JSON.stringify({
        type: "ready",
        agentVersion: MIN_NODE_VERSION,
        protocolVersion: NODE_PROTOCOL_VERSION,
        os: "linux",
        arch: "x64",
        hostname: "box",
        dataDir: "/tmp/agent",
        capabilities: [],
      }),
    );
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "online", "ready → online");

    // UNSOLICITED inventory (P3-T8b): no `inventory` command was ever sent — the
    // agent pushes its first snapshot right after `ready`. The handler's
    // `inventory` case is command-agnostic BY CONSTRUCTION (no RPC correlation on
    // this path), so the frame must land on the row exactly like a command answer.
    const old = new Date(Date.now() - 10_000).toISOString();
    ws.send(JSON.stringify({ type: "inventory", harnesses: [{ harnessId: "pi", installed: true }], ts: old }));
    await waitFor(async () => (await nodes.findById(nodeId))?.inventoryJson !== null, "inventory persisted");
    const stocked = await nodes.findById(nodeId);
    if (!stocked?.inventoryJson || !stocked.inventoryAt) throw new Error("unreachable: waitFor proved both set");
    expect(JSON.parse(stocked.inventoryJson)).toEqual([{ harnessId: "pi", installed: true }]);
    // The row stamps ITS OWN arrival time, never the frame's (stale) ts —
    // this is what makes the create-time freshness gate read the snapshot as new.
    expect(Date.parse(stocked.inventoryAt)).toBeGreaterThan(Date.parse(old));

    ws.close();
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
    expect(getLive(nodeId)).toBeUndefined();
  });

  it("key not bound to the node row is refused pre-socket (403 tier)", async () => {
    const nodeId = unique("n");
    await nodes.create({
      id: nodeId,
      ownerUserId: unique("u"),
      name: unique("node"),
      kind: "agent",
      status: "offline",
    });
    await nodes.setApiKeyId(nodeId, "the-real-key-id");
    keyStore.set("stale", { id: "some-other-key", nodeId });
    await expect(connect("Bearer stale")).rejects.toThrow("handshake refused");

    // Wire level: a valid NODE key aimed at the wrong binding is a 403
    // ACCESS_DENIED (rotation/stale-key tier), distinct from the 401 above.
    const res = await rawHandshake("Bearer stale");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; statusCode?: number };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.statusCode).toBe(403);
  });

  it("a disabled owner's node key is refused pre-socket, and re-enabling is the whole recovery", async () => {
    // Ruling 2026-09-24 over the REAL wire stack: the refusal is a pre-socket
    // HTTP 403 the agent's backoff loop sees as a failed dial — no socket,
    // nothing half-authenticated — and the moment the account is re-enabled
    // the very next dial succeeds on the same, untouched key.
    const owner = unique("u");
    const nodeId = unique("n");
    const apiKeyId = unique("k");
    const key = unique("secret");
    await nodes.create({ id: nodeId, ownerUserId: owner, name: unique("node"), kind: "agent", status: "offline" });
    await nodes.setApiKeyId(nodeId, apiKeyId);
    keyStore.set(key, { id: apiKeyId, nodeId });

    disabledOwners.add(owner);
    await expect(connect(`Bearer ${key}`)).rejects.toThrow("handshake refused");
    const res = await rawHandshake(`Bearer ${key}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toContain("disabled");
    expect(getLive(nodeId)).toBeUndefined();

    disabledOwners.delete(owner); // what the admin's PATCH does to the flag
    const ws = await connect(`Bearer ${key}`);
    await waitFor(() => getLive(nodeId)?.ws !== undefined, "registry attach after re-enable");
    ws.close();
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
  });
});
