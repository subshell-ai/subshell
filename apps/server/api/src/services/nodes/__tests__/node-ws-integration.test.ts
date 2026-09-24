import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MIN_NODE_VERSION, NODE_MAX_FRAME_BYTES, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import {
  createClientSession,
  generateLinkKeyPair,
  type LinkKeyPair,
} from "@internal/subshell-protocol/node-link-crypto";
import { Elysia } from "elysia";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { getHeld, getLive, isNodeOffline, resetNodeRegistryForTests } from "../node-registry.js";
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

// The link machine's server static + a canonical node static, generated once
// before any socket dials. A handshake-row test pins a row's encryptPublicKey to
// `nodeStatic.publicKey` and drives a client derived from `serverStatic`.
let serverStatic: LinkKeyPair;
let nodeStatic: LinkKeyPair;

const verifyApiKey: NodeWsDeps["verifyApiKey"] = async (rawKey) => {
  const row = keyStore.get(rawKey);
  return row ? { id: row.id, metadata: { kind: "node", nodeId: row.nodeId } } : null;
};

const deps: NodeWsDeps = {
  verifyApiKey,
  nodes,
  accountDisabled: async (userId) => disabledOwners.has(userId),
  resolveResult: () => false, // no RPC in flight in this test
  link: {
    // The binding re-prove re-RUNS the same bearer verification the upgrade did.
    verifyApiKey,
    loadNodeEncryptionKeys: async () => serverStatic,
    nodeEncryptionPublicKey: async () => serverStatic.publicKey,
    setEncryptPublicKey: (id, key) => nodes.setEncryptPublicKey(id, key),
  },
};

/**
 * Every NON-TEXT frame the message hook received, as Elysia delivered it
 * (task 6 plumbing proof: the `ws.plugin.ts` filter shape passes Buffers
 * through to the handler, which does its own shape work — nothing is
 * normalized at the plugin edge).
 */
const nonTextFrames: Array<{ typeof: string; isBuffer: boolean }> = [];

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
      // The same predicate `ws.plugin.ts` uses (string or object passes).
      if (typeof message === "string" || (message && typeof message === "object")) {
        if (typeof message !== "string") {
          nonTextFrames.push({ typeof: typeof message, isBuffer: Buffer.isBuffer(message) });
        }
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
  serverStatic = await generateLinkKeyPair();
  nodeStatic = await generateLinkKeyPair();
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

  const readyBody = {
    type: "ready",
    agentVersion: MIN_NODE_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    dataDir: "/tmp/agent",
    capabilities: [] as string[],
  };

  it("full lifecycle (handshake row): open → kx→binding establishes → encrypted ready marks online → close marks offline", async () => {
    // Since Task 8 every real frame is pre-classified through the link machine,
    // so a node that comes ONLINE must have negotiated an encrypted link — a
    // v14 plaintext `ready` on a legacy row is no longer a path to online (it is
    // ledger R3's held case, asserted separately below). This drives the REAL
    // handshake over the REAL ws stack with the REAL crypto: the client's
    // ephemeral derives the same session the server's does, the binding re-proves
    // the bearer key INSIDE the encrypted channel, and every post-establishment
    // frame is ciphertext.
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
    // Pinned BEFORE dial, so the upgrade classifies this socket `handshake`.
    await nodes.setEncryptPublicKey(nodeId, nodeStatic.publicKey);

    const client = await createClientSession({ serverStaticPublicKey: serverStatic.publicKey });
    const ws = await connect(`Bearer ${key}`);
    await waitFor(() => getLive(nodeId)?.ws !== undefined, "registry attach");

    // kx: fresh ephemeral + the row's pinned node static. Consumed in silence
    // (ruling R6) — the binding that follows is already ciphertext.
    ws.send(JSON.stringify({ t: "kx", eph: client.ephemeralPublicKey, pub: nodeStatic.publicKey }));
    // binding: nodeId + the SAME bearer key re-proved + protocol, sealed by the
    // just-derived session. Establishing sets `conn.link` on the registry record.
    ws.send(client.session.sealFrame(JSON.stringify({ nodeId, nodeKey: key, protocolVersion: NODE_PROTOCOL_VERSION })));
    await waitFor(() => getLive(nodeId)?.link !== undefined, "link established (conn.link set)");

    // Encrypted ready → the machine decrypts and forwards into the untouched
    // `applyReady` path; the row flips online.
    ws.send(client.session.sealFrame(JSON.stringify(readyBody)));
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "online", "encrypted ready → online");

    // UNSOLICITED inventory (P3-T8b), now also ciphertext: the handler's
    // `inventory` case is command-agnostic BY CONSTRUCTION (no RPC correlation on
    // this path), so the frame lands on the row exactly like a command answer.
    const old = new Date(Date.now() - 10_000).toISOString();
    ws.send(
      client.session.sealFrame(
        JSON.stringify({ type: "inventory", harnesses: [{ harnessId: "pi", installed: true }], ts: old }),
      ),
    );
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

  it("R3 (spec 2026-09-24) — a PIN-LESS row's plaintext ready that passes both gates is HELD encryption-required, never online", async () => {
    // The whole point of R3 made concrete on the real stack: an agent claiming
    // protocol 14 at the version floor, but whose row has no encryption pin, has
    // exactly one legitimate first frame (`register`). A plain `ready` wearing
    // 14 is indistinguishable from the downgrade the handshake exists to refuse,
    // so it is held for `update` — offline for every other purpose — and NEVER
    // brought online. No pin is set on this row, so the upgrade classifies it
    // `legacy` and the machine applies R3.
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

    // Spy `applyReady` so "NEVER online" is pinned as "the row's identity write
    // never runs", not merely "it ends offline." A downgrade attempt must not
    // get its self-claimed identity persisted onto the row (unlike the
    // below-floor hold, which does record the genuinely-old agent).
    const originalApplyReady = deps.nodes.applyReady.bind(deps.nodes);
    let applyReadyCalls = 0;
    deps.nodes.applyReady = async (id, report) => {
      applyReadyCalls += 1;
      return originalApplyReady(id, report);
    };
    try {
      const ws = await connect(`Bearer ${key}`);
      await waitFor(() => getLive(nodeId)?.ws !== undefined, "registry attach");

      ws.send(JSON.stringify(readyBody));
      await waitFor(
        async () =>
          getHeld(nodeId)?.reason === "encryption-required" && (await nodes.findById(nodeId))?.status === "offline",
        "held encryption-required + row offline",
      );

      expect(getHeld(nodeId)).toMatchObject({ reason: "encryption-required", agentVersion: MIN_NODE_VERSION });
      // Offline for every purpose but `update`: out of the live registry.
      expect(getLive(nodeId)).toBeUndefined();
      expect(isNodeOffline(nodeId)).toBe(true);
      // The row was never brought online, and its identity columns were never
      // written — applyReady did not run.
      expect(applyReadyCalls).toBe(0);
      const row = await nodes.findById(nodeId);
      expect(row?.status).toBe("offline");
      expect(row?.agentVersion).toBeNull();
      ws.close();
    } finally {
      deps.nodes.applyReady = originalApplyReady;
    }
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

  /* ---------------- binary-wire plumbing (task 6) ---------------- */

  /** Enrolled row + working key from the fake store, ready to dial. */
  async function fixtureNode(): Promise<{ nodeId: string; key: string }> {
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
    return { nodeId, key };
  }

  it("binary frames reach the node handler as Buffers; under-cap ciphertext does not close (R2 on the wire)", async () => {
    const { nodeId, key } = await fixtureNode();
    const ws = await connect(`Bearer ${key}`);
    await waitFor(() => getLive(nodeId)?.ws !== undefined, "registry attach");
    let clientClose: number | undefined;
    ws.addEventListener("close", (ev) => {
      clientClose = ev.code;
    });
    nonTextFrames.length = 0;

    // Step 3 verification: the ws.plugin filter shape (string or object) lets
    // a Buffer through to the handler untouched — Elysia delivers binary
    // frames as Buffers, `typeof "object"`, and NOTHING normalizes them at
    // the plugin edge (the node handler does its own shape work).
    ws.send(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => nonTextFrames.length === 1, "small binary frame reaches the message hook");
    expect(nonTextFrames[0]).toEqual({ typeof: "object", isBuffer: true });

    // Ruling R2 at the wire: 1016 KiB sits UNDER the 1 MiB node cap, but the
    // old JSON.stringify measurement inflated a Buffer to its
    // `{"type":"Buffer","data":[…]}` form — ~4× the size — and would have
    // closed this 1009. With the fix the handler sees the real size, drops
    // the unrecognized ciphertext, and the socket lives.
    ws.send(new Uint8Array(NODE_MAX_FRAME_BYTES - 1024));
    await waitFor(() => nonTextFrames.length === 2, "near-cap binary frame reaches the message hook");
    await new Promise((r) => setTimeout(r, 100)); // a stray close lands well inside this beat
    expect(clientClose).toBeUndefined();
    expect(getLive(nodeId)).toBeDefined();
    ws.close();
  });

  it("oversized binary frames are closed 1009 by the HANDLER's byte guard", async () => {
    const { nodeId, key } = await fixtureNode();
    const ws = await connect(`Bearer ${key}`);
    await waitFor(() => getLive(nodeId)?.ws !== undefined, "registry attach");
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason })),
    );

    ws.send(new Uint8Array(NODE_MAX_FRAME_BYTES + 1024));
    const c = await closed; // the suite timeout is the failure net
    expect(c.code).toBe(1009);
    // The handler's OWN close, naming the node cap — not Bun's payload guard
    // (which would close with its own message), so this proves the frame
    // travelled filter → handler → size check end to end.
    expect(c.reason).toContain(`frame exceeds ${NODE_MAX_FRAME_BYTES} bytes`);
  });
});
