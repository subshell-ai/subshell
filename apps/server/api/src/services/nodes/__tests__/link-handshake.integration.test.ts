import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  type ControlKeyPair,
  JtiLru,
  MIN_NODE_VERSION,
  NODE_CLOSE_HANDSHAKE_REQUIRED,
  NODE_CLOSE_REPAIR_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeCommandBody,
  SeqTracker,
  verifyCommand,
} from "@internal/subshell-protocol";
import {
  createClientSession,
  createServerSession,
  generateLinkKeyPair,
  type LinkKeyPair,
  type LinkSession,
  parseLinkAck,
  parseRegisterOkFrame,
  type RegisterOkFrame,
} from "@internal/subshell-protocol/node-link-crypto";
import { Elysia } from "elysia";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { loadControlKeys } from "../control-keys.js";
import { resetNodeEventsForTests, subscribeOutput } from "../node-events.js";
import {
  disconnectNode,
  getHeld,
  getLive,
  isNodeOffline,
  REVOKED_CLOSE_CODE,
  resetNodeRegistryForTests,
} from "../node-registry.js";
import { binaryPayload, failConnPendings, resolveResult, sendCommand } from "../node-rpc.js";
import {
  authenticateNodeUpgrade,
  handleNodeClose,
  handleNodeMessageQueued,
  handleNodeOpen,
  type NodeWsDeps,
  type NodeWsSocket,
} from "../node-ws-handler.js";

/**
 * Task 11 — the end-to-end proof for the encrypted node link (spec 2026-09-24
 * §7): the WHOLE lifecycle over `Bun.serve`-backed real WebSockets with the
 * REAL `node-link-crypto` on both ends. Nothing is faked but the better-auth
 * key store and the account flag — the same two substitutions
 * `node-ws-integration.test.ts` sanctions. The scripted peer mirrors the
 * agent's `link-crypto.ts` sequence verbatim (ruling R6: `[kx-text,
 * sealed-binding]` back-to-back, the server's first bytes the sealed
 * `{t:"ok"}`), so every assertion runs against the state machine production
 * runs — including the real `sendCommand` (real control-key signing, real
 * sealed envelope) and the real RPC correlator.
 *
 * The wire claim is pinned from BOTH sides: the client records every inbound
 * `MessageEvent` type, and the server's message hook records the delivered
 * shape per node. After the `kx` exchange, every frame each direction sees is
 * binary; zero JSON text.
 */

const salt = Math.random().toString(36).slice(2, 8);
let seq = 0;
const unique = (p: string) => `${p}-${process.pid}-${salt}-${seq++}`;

const nodes = new NodesRepository(db);

/** raw bearer key → bound (apiKeyId, nodeId) — the fake better-auth store. */
const keyStore = new Map<string, { id: string; nodeId: string }>();

// The link machine's server static, a SECOND server static (the wrong-pin
// negative), and two node statics (the replay test needs another node whose
// pin must refuse the first one's captured bytes).
let serverStatic: LinkKeyPair;
let wrongServerStatic: LinkKeyPair;
/** The REAL control keypair's public half — agents verify with it. */
let controlPublicJwk: ControlKeyPair["publicJwk"];

/** Every bearer verification the machine ran, in order (the replay proof). */
const verifyCalls: string[] = [];
const verifyApiKey: NodeWsDeps["verifyApiKey"] = async (rawKey) => {
  verifyCalls.push(rawKey);
  const row = keyStore.get(rawKey);
  return row ? { id: row.id, metadata: { kind: "node", nodeId: row.nodeId } } : null;
};

let detectKicks = 0;

const deps: NodeWsDeps = {
  verifyApiKey,
  nodes,
  accountDisabled: async () => false,
  // The REAL RPC correlator: the round trip settles `sendCommand` through it.
  resolveResult,
  // Counted noop: the real kick would ship a `detect` command on every ready
  // and randomize the frame script; the COUNT is what proves the kick fired.
  detect: () => {
    detectKicks += 1;
  },
  link: {
    verifyApiKey,
    loadNodeEncryptionKeys: async () => serverStatic,
    nodeEncryptionPublicKey: async () => serverStatic.publicKey,
    setEncryptPublicKey: (id, key) => nodes.setEncryptPublicKey(id, key),
  },
};

/**
 * Every frame the message hook received, per node, as Elysia delivered it:
 * `bytes` (Buffer ciphertext), `text` (raw string), `object` (a TEXT frame
 * Elysia JSON-pre-parsed — plaintext wearing a parsed shape, NOT ciphertext).
 */
const inbound: Array<{ nodeId: string; kind: "bytes" | "text" | "object" }> = [];

const app = new Elysia()
  .use(errorHandlerPlugin)
  .ws("/ws/node", {
    async upgrade(context) {
      const request = (context as { request: Request }).request;
      const identity = await authenticateNodeUpgrade(deps, request.headers.get("authorization"));
      Object.assign(context as Record<string, unknown>, identity);
    },
    open(ws) {
      void handleNodeOpen(deps, ws as unknown as NodeWsSocket);
    },
    message(ws, message) {
      const nodeId = (ws as unknown as NodeWsSocket).data.nodeId;
      // The same predicate `ws.plugin.ts` uses (string or object passes).
      if (typeof message === "string" || (message && typeof message === "object")) {
        if (nodeId) {
          const kind =
            typeof message === "string"
              ? "text"
              : message instanceof Uint8Array || message instanceof ArrayBuffer
                ? "bytes"
                : "object";
          inbound.push({ nodeId, kind });
        }
        // THE PRODUCTION ENTRY POINT — the serialized chain, not the raw
        // dispatcher: the scripted agents ship binding right behind kx, and
        // the chain is what orders the frames the machine reads.
        void handleNodeMessageQueued(deps, ws as unknown as NodeWsSocket, message as string | object).catch(() => {});
      }
    },
    close(ws) {
      void handleNodeClose(deps, ws as unknown as NodeWsSocket);
    },
  })
  .listen(0);

const port = () => app.server?.port as number;

async function waitFor(cond: () => Promise<boolean> | boolean, what: string, budgetMs = 5000): Promise<void> {
  for (let waited = 0; ; waited += 20) {
    if (await cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Open a client socket; resolves on `open`, rejects on pre-socket refusal. */
function connect(header: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port()}/ws/node`, { headers: { Authorization: header } });
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("handshake refused")), { once: true });
  });
}

/** Binary frames arrive as Buffer/ArrayBuffer on both Bun sides; normalize. */
function asBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
}

/** Enrolled row + working key, optionally pre-pinned, ready to dial. */
async function fixtureNode(opts: { pin?: LinkKeyPair } = {}): Promise<{ nodeId: string; key: string }> {
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
  if (opts.pin) await nodes.setEncryptPublicKey(nodeId, opts.pin.publicKey);
  return { nodeId, key };
}

const readyBody = (hostname = "box") => ({
  type: "ready",
  agentVersion: MIN_NODE_VERSION,
  protocolVersion: NODE_PROTOCOL_VERSION,
  os: "linux",
  arch: "x64",
  hostname,
  dataDir: "/tmp/agent",
  capabilities: [] as string[],
});

/**
 * The scripted agent — the PLANE's mirror of `apps/node/agent/src/link-crypto.ts`'s
 * negotiator over a REAL `WebSocket`. Handshake mode emits `[kx-text,
 * sealed-binding]` back-to-back and treats the first inbound bytes as the ack;
 * register mode emits `{t:"register"}`, expects the plaintext `register-ok`
 * and then closes NORMALLY (ruling R7). Established, it opens every ciphertext
 * frame, verifies every command envelope against the REAL control key (with
 * the agent's own per-node `JtiLru` / per-connection `SeqTracker`), and answers
 * with a sealed `result`. Every outbound frame is recorded verbatim so the
 * replay test can capture a legitimate connection's exact bytes.
 */
class FakeAgent {
  readonly wireIn: Array<"text" | "binary"> = [];
  readonly sent: Array<{ kind: "text" | "binary"; data: string | Uint8Array }> = [];
  readonly cmds: Array<{ jti: string; seq: number; cmd: NodeCommandBody }> = [];
  readonly unexpectedText: string[] = [];
  registerOk: RegisterOkFrame | undefined;
  established = false;
  closeInfo: { code: number; reason: string } | undefined;

  private ws: WebSocket | undefined;
  private session: LinkSession | undefined;
  private readonly seqTracker = new SeqTracker();
  // Declared BEFORE the promise that resolves it: the executor runs during
  // THIS field's initialization, and a define-semantics redeclaration below
  // would wipe the assignment.
  private closeResolve!: (v: { code: number; reason: string }) => void;
  private readonly closed = new Promise<{ code: number; reason: string }>((r) => {
    this.closeResolve = r;
  });

  constructor(
    private readonly cfg: {
      nodeId: string;
      key: string;
      /** The node's LONG-TERM static — the identity claimed in `kx.pub`. */
      nodeStatic: LinkKeyPair;
      /** The pinned control static — WRONG on purpose in the negative tests. */
      controlStaticPub: string;
      mode: "handshake" | "register";
    },
    private readonly jtiLru: JtiLru,
  ) {}

  async dial(): Promise<void> {
    const ws = await connect(`Bearer ${this.cfg.key}`);
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        this.wireIn.push("text");
        this.onText(ev.data);
        return;
      }
      this.wireIn.push("binary");
      void this.onBytes(asBytes(ev.data));
    });
    ws.addEventListener(
      "close",
      (ev) => {
        this.closeInfo = { code: ev.code, reason: ev.reason };
        this.closeResolve(this.closeInfo);
      },
      { once: true },
    );

    if (this.cfg.mode === "register") {
      this.send({ kind: "text", data: JSON.stringify({ t: "register", pub: this.cfg.nodeStatic.publicKey }) });
      return;
    }
    const derived = await createClientSession({ serverStaticPublicKey: this.cfg.controlStaticPub });
    this.session = derived.session;
    // R6: kx and the sealed binding ship back-to-back; nothing inbound between.
    this.send({
      kind: "text",
      data: JSON.stringify({ t: "kx", eph: derived.ephemeralPublicKey, pub: this.cfg.nodeStatic.publicKey }),
    });
    this.send({
      kind: "binary",
      data: derived.session.sealFrame(
        JSON.stringify({
          nodeId: this.cfg.nodeId,
          nodeKey: this.cfg.key,
          protocolVersion: NODE_PROTOCOL_VERSION,
        }),
      ),
    });
  }

  /** Seal `obj` with the established session and send it as a binary frame. */
  sealAndSend(obj: unknown): Uint8Array {
    if (!this.session) throw new Error("sealAndSend before establishment");
    const bytes = this.session.sealFrame(JSON.stringify(obj));
    this.send({ kind: "binary", data: bytes });
    return bytes;
  }

  sendText(text: string): void {
    this.send({ kind: "text", data: text });
  }

  sendRawBinary(bytes: Uint8Array): void {
    this.send({ kind: "binary", data: bytes });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
  }

  waitClosed(): Promise<{ code: number; reason: string }> {
    return this.closed;
  }

  /** Frames sent AFTER the opening kx — the established stream's script. */
  sentAfterKx(): Array<{ kind: "text" | "binary"; data: string | Uint8Array }> {
    const kxAt = this.sent.findIndex(
      (f) => f.kind === "text" && typeof f.data === "string" && f.data.includes('"t":"kx"'),
    );
    return kxAt === -1 ? this.sent : this.sent.slice(kxAt + 1);
  }

  private send(frame: { kind: "text" | "binary"; data: string | Uint8Array }): void {
    this.sent.push(frame);
    // The agent's OWN lesson (binaryPayload): a bare Uint8Array can be
    // text-framed by some send paths; hand the socket a Buffer view.
    this.ws?.send(frame.kind === "text" ? frame.data : binaryPayload(frame.data as Uint8Array));
  }

  private onText(text: string): void {
    if (this.cfg.mode === "register" && !this.registerOk) {
      const ok = parseRegisterOkFrame(JSON.parse(text) as unknown);
      if (ok) {
        this.registerOk = ok;
        this.close(); // R7: the registering socket closes NORMALLY and redials encrypted
        return;
      }
    }
    this.unexpectedText.push(text); // plaintext the machine must refuse — never consumed
  }

  private async onBytes(bytes: Uint8Array): Promise<void> {
    if (!this.session) return; // no stream to open (register mode)
    const plaintext = this.session.openFrame(bytes);
    if (plaintext === null) {
      // An undecryptable inbound frame. The agent's doctrine is to close on
      // it, but in every test here the SERVER caused the death and its close
      // is already in flight; record and let the close event land.
      this.unexpectedText.push("<undecryptable inbound bytes>");
      return;
    }
    if (!this.established) {
      if (parseLinkAck(JSON.parse(plaintext) as unknown)) {
        this.established = true;
        return;
      }
      this.unexpectedText.push(`first inbound frame was not the ack: ${plaintext}`);
      return;
    }
    const parsed = JSON.parse(plaintext) as { jws?: string };
    if (!parsed.jws) return; // a plane-originated event frame (none in this script)
    const outcome = await verifyCommand(parsed.jws, controlPublicJwk, {
      nodeId: this.cfg.nodeId,
      jtiLru: this.jtiLru,
      seqTracker: this.seqTracker,
    });
    if (!outcome.ok) {
      this.unexpectedText.push(`command verification failed: ${outcome.reason}`);
      return;
    }
    this.cmds.push({ jti: outcome.claims.jti, seq: outcome.claims.seq, cmd: outcome.claims.cmd });
    this.sealAndSend({ type: "result", ref: outcome.claims.jti, ok: true, data: { ack: outcome.claims.cmd.type } });
  }
}

/**
 * Drive one full establishment through the scripted agent: dial, handshake,
 * ack opened, `ready` sealed (which lands the row online and triggers the
 * plane's connect-time pushes). `sendReady: false` establishes only — the
 * replay capture wants a row whose identity columns were never written.
 */
async function establish(opts: {
  nodeId: string;
  key: string;
  nodeStatic: LinkKeyPair;
  controlStaticPub?: string;
  jtiLru?: JtiLru;
  sendReady?: boolean;
}): Promise<FakeAgent> {
  const agent = new FakeAgent(
    {
      nodeId: opts.nodeId,
      key: opts.key,
      nodeStatic: opts.nodeStatic,
      controlStaticPub: opts.controlStaticPub ?? serverStatic.publicKey,
      mode: "handshake",
    },
    opts.jtiLru ?? new JtiLru(),
  );
  await agent.dial();
  await waitFor(() => agent.established, "sealed ok ack opened");
  if (opts.sendReady !== false) {
    agent.sealAndSend(readyBody());
    await waitFor(async () => (await nodes.findById(opts.nodeId))?.status === "online", "encrypted ready → online");
  }
  return agent;
}

beforeAll(async () => {
  await runMigrations();
  serverStatic = await generateLinkKeyPair();
  wrongServerStatic = await generateLinkKeyPair();
  // The SAME store `node-rpc`'s `loadControlKeys` uses on first command: the
  // scripted agents verify envelopes against the key they were signed with.
  controlPublicJwk = (await loadControlKeys()).publicJwk;
});

afterAll(() => {
  app.server?.stop(true);
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
});

describe("the encrypted link — full round trip over real sockets", () => {
  it("kx → binding → ok → ready(online) → sealed command → result → output relay, binary-only wire", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    const lru = new JtiLru();
    const agent = await establish({ nodeId, key, nodeStatic, jtiLru: lru });
    expect(detectKicks).toBeGreaterThan(0); // the connect-time detection kick fired

    // The ready path's allowlist reconciliation is ITSELF a sealed command
    // (`node-rpc` seals once conn.link is set) — the agent verified it against
    // the real control key, so signing + sealing + opening all worked before
    // the explicit round trips below.
    await waitFor(() => agent.cmds.some((c) => c.cmd.type === "set_allowed_dirs"), "sealed set_allowed_dirs push");

    // A real `sendCommand` — control-key signing, jti correlation, envelope
    // sealed over the link, the agent's sealed `result` settling the promise.
    const pinged = await sendCommand(nodeId, { type: "ping" });
    expect(pinged).toEqual({ ack: "ping" });

    // The pane-byte direction server → agent: an `input` command, sealed.
    await sendCommand(nodeId, { type: "input", subshellId: "pane-1", data: "echo hi" });
    const input = agent.cmds.find((c) => c.cmd.type === "input");
    expect(input?.cmd).toEqual({ type: "input", subshellId: "pane-1", data: "echo hi" });
    // `seq` is per-connection and strictly ascending on the wire.
    const seqs = agent.cmds.map((c) => c.seq);
    expect(seqs.every((s, i) => s > (seqs[i - 1] ?? 0))).toBe(true);
    // Every envelope verified: nothing the agent saw failed the control key.
    expect(agent.unexpectedText).toEqual([]);

    // The pane-byte direction agent → server: an `output` event, sealed,
    // landing on the output-bus subscriber through the real dispatch path.
    const subId = crypto.randomUUID();
    const seen: Array<Record<string, unknown>> = [];
    const dispose = subscribeOutput(subId, (ev) => seen.push({ ...ev }));
    agent.sealAndSend({
      type: "output",
      subshellId: "pane-1",
      subId,
      fromByte: 0,
      toByte: 5,
      data_b64: Buffer.from("hello").toString("base64"),
    });
    await waitFor(() => seen.length === 1, "sealed output event → bus");
    expect(seen[0]).toMatchObject({ type: "output", subId, fromByte: 0, toByte: 5 });
    expect(Buffer.from(seen[0].data_b64 as string, "base64").toString()).toBe("hello");
    dispose();

    // WIRE PROOF, both sides. Client: every inbound frame it ever saw was
    // binary — the ack, the pushes; no JSON text on the established socket.
    expect(agent.wireIn.length).toBeGreaterThan(1);
    expect(agent.wireIn.filter((k) => k !== "binary")).toEqual([]);
    // Client outbound after the kx: binding, ready, every result reply — all
    // ciphertext.
    expect(agent.sentAfterKx().every((f) => f.kind === "binary")).toBe(true);
    // Server inbound: exactly one text-shape frame for the whole session —
    // the kx (Elysia pre-parses it, so it lands as an `object`: plaintext in a
    // parsed shape, and STILL not ciphertext) — and then bytes only.
    const mine = inbound.filter((f) => f.nodeId === nodeId);
    expect(mine[0]).toEqual({ nodeId, kind: "object" }); // the kx
    expect(mine.slice(1).every((f) => f.kind === "bytes")).toBe(true);
    expect(mine.slice(1).length).toBeGreaterThanOrEqual(4); // binding, ready, result(s), output

    agent.close();
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
    expect(getLive(nodeId)).toBeUndefined();
  });
});

describe("the negative matrix on the real pair", () => {
  it("a client deriving against the WRONG pinned control static: binding undecryptable → 4410, never online", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    // The row's pin MATCHES the claim, so the kx is accepted and the server
    // derives; the client's side derives against someone else's static, so
    // the plane cannot open the binding — server authentication is exactly
    // this step (spec §2: only a holder of the server static makes the node's
    // ciphertext decryptable, and vice versa).
    const agent = new FakeAgent(
      { nodeId, key, nodeStatic, controlStaticPub: wrongServerStatic.publicKey, mode: "handshake" },
      new JtiLru(),
    );
    await agent.dial();
    const c = await agent.waitClosed();
    expect(c.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(c.reason).toContain("binding undecryptable");
    expect(agent.established).toBe(false);
    const row = await nodes.findById(nodeId);
    expect(row?.status).toBe("offline");
    expect(row?.agentVersion).toBeNull(); // the socket never reached ready
  });

  it("a kx whose claimed pub is NOT the row's pin → 4410 (the pin compare runs before any derivation)", async () => {
    const pinned = await generateLinkKeyPair();
    const actuallyRunning = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: pinned });
    const agent = new FakeAgent(
      { nodeId, key, nodeStatic: actuallyRunning, controlStaticPub: serverStatic.publicKey, mode: "handshake" },
      new JtiLru(),
    );
    await agent.dial();
    const c = await agent.waitClosed();
    expect(c.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(c.reason).toContain("pub mismatch");
    const row = await nodes.findById(nodeId);
    expect(row?.status).toBe("offline");
    expect(row?.agentVersion).toBeNull();
  });

  it("REPLAY: connect #1's captured bytes verbatim onto a fresh socket are refused, and touch no row", async () => {
    // Node A: a legitimate connect that ESTABLISHES (no ready — so A's row's
    // identity columns stay null and any write from a replayed frame is
    // detectable). These are the exact bytes an on-path captor would record.
    const staticA = await generateLinkKeyPair();
    const a = await fixtureNode({ pin: staticA });
    const agent1 = await establish({ nodeId: a.nodeId, key: a.key, nodeStatic: staticA, sendReady: false });
    const capturedKx = agent1.sent[0].data as string;
    const capturedBinding = agent1.sent[1].data as Uint8Array;
    agent1.close();
    await waitFor(() => agent1.closeInfo !== undefined, "connect #1 closed");
    const verifyCallsBefore = verifyCalls.length;
    const aKeyCallsBefore = verifyCalls.filter((k) => k === a.key).length;

    // Node B: a DIFFERENT pinned row. A's bytes replay verbatim onto it.
    const staticB = await generateLinkKeyPair();
    const b = await fixtureNode({ pin: staticB });
    const ws2 = await connect(`Bearer ${b.key}`);
    const closed2 = new Promise<{ code: number; reason: string }>((r) =>
      ws2.addEventListener("close", (ev) => r({ code: ev.code, reason: ev.reason }), { once: true }),
    );

    ws2.send(capturedKx);
    ws2.send(binaryPayload(capturedBinding));
    const c2 = await closed2; // the suite timeout is the failure net
    expect(c2.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(c2.reason).toContain("pub mismatch"); // refused before ANY derivation

    // Touches no row: B never went online and its identity columns were never
    // written; the socket died at the kx, so the binding — whose jti-free
    // payload carries A's nodeId and A's node key — was never decrypted, and
    // A's key was never re-proved against anything.
    const rowB = await nodes.findById(b.nodeId);
    expect(rowB).toMatchObject({ status: "offline", agentVersion: null, inventoryJson: null });
    const rowA = await nodes.findById(a.nodeId);
    expect(rowA).toMatchObject({ status: "offline", agentVersion: null });
    expect(verifyCalls.filter((k) => k === a.key).length).toBe(aKeyCallsBefore);
    // Exactly ONE new verification since the capture: socket B's UPGRADE of
    // B's own key. The binding re-prove never ran.
    expect(verifyCalls.length).toBe(verifyCallsBefore + 1);
    expect(verifyCalls[verifyCalls.length - 1]).toBe(b.key);

    // Variant on A itself: its captured BINDING ciphertext replayed onto a
    // fresh socket WITHOUT its kx — wrong kind at the wrong phase, refused,
    // and A's row still never written by any replayed frame.
    const ws3 = await connect(`Bearer ${a.key}`);
    const closed3 = new Promise<{ code: number; reason: string }>((r) =>
      ws3.addEventListener("close", (ev) => r({ code: ev.code, reason: ev.reason }), { once: true }),
    );
    ws3.send(binaryPayload(capturedBinding));
    const c3 = await closed3;
    expect(c3.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(c3.reason).toContain("ciphertext before kx");
    expect((await nodes.findById(a.nodeId))?.agentVersion).toBeNull();
    expect(getLive(a.nodeId)).toBeUndefined();
  });

  it("oversized ciphertext on an established link → 1009 (the size cap runs before the machine)", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    const agent = await establish({ nodeId, key, nodeStatic });
    const closed = agent.waitClosed();
    agent.sendRawBinary(new Uint8Array(NODE_MAX_FRAME_BYTES + 1024));
    const c = await closed;
    expect(c.code).toBe(1009);
    expect(c.reason).toContain(`frame exceeds ${NODE_MAX_FRAME_BYTES} bytes`);
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
  });

  it("a flipped byte mid-stream → 4410, and the socket is NOT half-resumed", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    const agent = await establish({ nodeId, key, nodeStatic });
    const before = await nodes.findById(nodeId);
    const closed = agent.waitClosed();

    // A legitimate heartbeat lands first (proving the stream was live at that
    // position), then a byte-corrupted COPY of it: the ratchet has advanced
    // past it, the pull fails, and a failed stream is DEAD — not mis-framed.
    const sealed = agent.sealAndSend({ type: "heartbeat", ts: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 80)); // a stray close lands well inside this beat
    expect(agent.closeInfo).toBeUndefined(); // the stream was live at that position
    const corrupted = Uint8Array.from(sealed);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    agent.sendRawBinary(corrupted);

    const c = await closed;
    expect(c.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(c.reason).toContain("stream is dead");
    expect(getLive(nodeId)).toBeUndefined(); // registry torn down, never half-held
    const after = await nodes.findById(nodeId);
    expect(after?.status).toBe("offline"); // close projected; no "online but deaf" window
    expect(after?.agentVersion).toBe(before?.agentVersion); // nothing after the flip was ever applied
  });

  it("an established link REFUSES plaintext: a text frame closes 4410 and is never processed", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    const agent = await establish({ nodeId, key, nodeStatic });
    const before = await nodes.findById(nodeId);
    const closed = agent.waitClosed();
    // The downgrade attempt's shape: plaintext that WOULD pass the gates.
    agent.sendText(JSON.stringify({ type: "heartbeat", ts: new Date().toISOString() }));
    const c = await closed;
    expect(c.code).toBe(NODE_CLOSE_HANDSHAKE_REQUIRED);
    expect(c.reason).toContain("plaintext on an established link");
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
    expect((await nodes.findById(nodeId))?.agentVersion).toBe(before?.agentVersion); // never parsed, never applied
  });
});

describe("the cutover matrix (spec §7)", () => {
  it("a legacy row's would-pass plaintext ready is HELD encryption-required — never online, never identity-written", async () => {
    const { nodeId, key } = await fixtureNode(); // no pin → legacy
    const originalApplyReady = deps.nodes.applyReady.bind(deps.nodes);
    let applyReadyCalls = 0;
    deps.nodes.applyReady = async (id, report) => {
      applyReadyCalls += 1;
      return originalApplyReady(id, report);
    };
    try {
      const ws = await connect(`Bearer ${key}`);
      // A protocol-14 `ready` in PLAINTEXT: the machine cannot tell it from
      // the downgrade the handshake exists to refuse, so ledger R3 holds it —
      // offline for everything but `update`, identity columns untouched.
      ws.send(JSON.stringify(readyBody()));
      await waitFor(async () => getHeld(nodeId)?.reason === "encryption-required", "held encryption-required");
      expect(getLive(nodeId)).toBeUndefined();
      expect(isNodeOffline(nodeId)).toBe(true);
      expect(applyReadyCalls).toBe(0);
      const row = await nodes.findById(nodeId);
      expect(row?.status).toBe("offline");
      expect(row?.agentVersion).toBeNull();
      ws.close();
    } finally {
      deps.nodes.applyReady = originalApplyReady;
    }
  });

  it("register self-heal: legacy row → register → register-ok → NORMAL close → next connect handshakes encrypted", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode(); // no pin → legacy
    const agent = new FakeAgent({ nodeId, key, nodeStatic, controlStaticPub: "", mode: "register" }, new JtiLru());
    await agent.dial();
    const c = await agent.waitClosed();
    expect(agent.registerOk).toEqual({ t: "register-ok", controlEncryptPublicKey: serverStatic.publicKey });
    expect(c.code).toBe(1000); // ruling R7 — a NORMAL close, not 4410
    // The pin landed, canonicalized (the fixture's keypair is canonical already).
    expect((await nodes.findById(nodeId))?.encryptPublicKey).toBe(nodeStatic.publicKey);

    // The NEXT connect is a full encrypted handshake → online.
    const agent2 = await establish({ nodeId, key, nodeStatic });
    expect(getLive(nodeId)).toBeDefined();
    agent2.close();
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
  });

  it("key_rotate clears the pin: kx REFUSED (R10) → register re-pins the SAME static (R11 keeps the pair) → next connect encrypted", async () => {
    const nodeStatic = await generateLinkKeyPair();
    const { nodeId, key } = await fixtureNode({ pin: nodeStatic });
    const lru = new JtiLru(); // per-NODE, surviving every redial (agent doctrine)
    const agent1 = await establish({ nodeId, key, nodeStatic, jtiLru: lru });

    // ── the plane half of `POST /api/nodes/:id/rotate-key`, step for step ──
    // 1. mint + bind the new key; 2. flip the binding and CLEAR the pin;
    // 3. disable the old key (the fake store: forget it); 4. evict the live
    // old-key socket and drain its in-flight commands.
    const k2 = unique("secret");
    const k2id = unique("k");
    keyStore.set(k2, { id: k2id, nodeId });
    await nodes.setApiKeyId(nodeId, k2id);
    await nodes.setEncryptPublicKey(nodeId, null);
    keyStore.delete(key);
    const evicted = getLive(nodeId);
    await disconnectNode(nodeId, REVOKED_CLOSE_CODE, "node key rotated");
    if (evicted) failConnPendings(evicted, "offline", "node key rotated");
    expect((await agent1.waitClosed()).code).toBe(REVOKED_CLOSE_CODE);

    // ── the agent's redial, still holding BOTH link fields in its config ──
    // The row is legacy now, so the handshake-mode kx CLAIM is refused: a
    // silent stall was R10's defect; the refusal is its remedy. R12b: the
    // refusal carries its OWN code — 4411, the re-pair signal — so a generic
    // 4410 (the handshake deadline) can never be mistaken for it agent-side.
    const dialer = new FakeAgent(
      { nodeId, key: k2, nodeStatic, controlStaticPub: serverStatic.publicKey, mode: "handshake" },
      lru,
    );
    await dialer.dial();
    const c2 = await dialer.waitClosed();
    expect(c2.code).toBe(NODE_CLOSE_REPAIR_REQUIRED);
    expect(c2.reason).toContain("re-pair via register");
    expect((await nodes.findById(nodeId))?.encryptPublicKey).toBeNull(); // the refusal writes nothing

    // ── R11 on the agent side: the pre-establishment 4411 drops ONLY the
    // control pin — the pair is kept — so the next begin() registers the
    // SAME static. ──
    const registrar = new FakeAgent({ nodeId, key: k2, nodeStatic, controlStaticPub: "", mode: "register" }, lru);
    await registrar.dial();
    const c3 = await registrar.waitClosed();
    expect(registrar.registerOk?.controlEncryptPublicKey).toBe(serverStatic.publicKey);
    expect(c3.code).toBe(1000);
    // The SAME identity re-pinned — not a fresh one, not the old bearer's.
    expect((await nodes.findById(nodeId))?.encryptPublicKey).toBe(nodeStatic.publicKey);

    // ── the third redial handshakes encrypted and comes online ──
    const healed = await establish({ nodeId, key: k2, nodeStatic, jtiLru: lru });
    expect(getLive(nodeId)).toBeDefined();
    healed.close();
    await waitFor(async () => (await nodes.findById(nodeId))?.status === "offline", "close → offline");
  });
});

describe("perf sanity (spec §7) + the compiled run path", () => {
  it("1000 secretstream frames round-trip over a real local socket in well under 2 s", async () => {
    // A minimal echo over a REAL `Bun.serve` WebSocket, both directions sealed
    // with the SAME `LinkSession` construction both products use. This times
    // the transport construction (spec §7's 17-byte-header question), not the
    // node machine's policy.
    const serverPair = await generateLinkKeyPair();
    const client = await createClientSession({ serverStaticPublicKey: serverPair.publicKey });
    const serverSession = await createServerSession({
      serverStatic: serverPair,
      clientEphemeralPublicKey: client.ephemeralPublicKey,
    });
    const echo = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          if (typeof msg === "string") return;
          const open = serverSession.openFrame(asBytes(msg));
          if (open === null) return;
          ws.send(binaryPayload(serverSession.sealFrame(open)));
        },
      },
    });

    const ws = new WebSocket(`ws://localhost:${echo.port}/`);
    await new Promise<void>((r, j) => {
      ws.addEventListener("open", () => r(), { once: true });
      ws.addEventListener("error", () => j(new Error("perf echo dial failed")), { once: true });
    });
    const opened: number[] = [];
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") return;
      if (client.session.openFrame(asBytes(ev.data)) !== null) opened.push(1);
    });

    const t0 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      ws.send(binaryPayload(client.session.sealFrame(JSON.stringify({ i, data: "x".repeat(64) }))));
    }
    await waitFor(() => opened.length === 1000, "all 1000 frames echoed back");
    const ms = performance.now() - t0;
    console.log(`[perf] 1000 secretstream frames, full-duplex round trip: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(2000); // a generous bound — the loud number is the point (no regression budget)
    ws.close();
    echo.stop(true);
  });

  it("the compiled binary's `run` path reaches the crypto: static import graph main → cli → daemon → link-crypto → subpath", () => {
    // `bun build --compile` bundles the STATIC import closure of the entry
    // (`compile` = `bun build --compile ./src/main.ts`). The handshake module
    // is NOT imported by `version`/`status --json`, so those commands cannot
    // prove the WASM rode along — the graph does: link-crypto is reachable
    // with zero dynamic imports, so the bundler sees it exactly as it sees the
    // tmux runner. (The compiled pair's live behavior is `test:cli`'s
    // headless scenario — see the task report.)
    const agentSrc = resolvePath(import.meta.dir, "../../../../../../node/agent/src");
    /**
     * Static module specifiers of one file: `import … from "…"`, bare
     * `import "…"`, `export … from "…"`. A comment that happens to sit
     * between the words can only ADD a false edge (the specifiers followed
     * here must resolve to real files, and the three direct-edge assertions
     * below are the actual gate); it can never drop a real named import.
     */
    const imported = (file: string): string[] => {
      const src = readFileSync(file, "utf8");
      const specs: string[] = [];
      for (const m of src.matchAll(/(?:import|export)[\s\S]*?\sfrom\s*"([^"]+)"|import\s+"([^"]+)"/g)) {
        const s = m[1] ?? m[2];
        if (s) specs.push(s);
      }
      return specs;
    };
    const local = (fromFile: string, spec: string): string | undefined => {
      if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
      const base = resolvePath(fromFile, "..", spec);
      for (const cand of [base.replace(/\.js$/, ".ts"), `${base.replace(/\.js$/, "")}/index.ts`, base]) {
        try {
          readFileSync(cand);
          return cand;
        } catch {
          // try the next spelling
        }
      }
      return undefined;
    };

    const main = resolvePath(agentSrc, "main.ts");
    const cli = resolvePath(agentSrc, "cli.ts");
    const daemon = resolvePath(agentSrc, "daemon.ts");
    const linkCrypto = resolvePath(agentSrc, "link-crypto.ts");
    // The exact edges the run path walks — each pinned by name, so making any
    // ONE of them lazy trips THIS assertion before the reachability one.
    expect(imported(main)).toContain("./cli.js");
    expect(imported(cli)).toContain("./daemon.js");
    expect(imported(daemon)).toContain("./link-crypto.js");
    expect(imported(linkCrypto)).toContain("@internal/subshell-protocol/node-link-crypto");

    // And the full static closure — what the bundler walks. If ANY edge
    // became a dynamic import, link-crypto would drop out of the binary.
    const seen = new Set<string>();
    const queue = [main];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of imported(file)) {
        const next = local(file, spec);
        if (next) queue.push(next);
      }
      if (seen.size > 1000) throw new Error("import walk runaway — a cycle of unresolvable edges?");
    }
    expect(seen.has(daemon)).toBe(true);
    expect(seen.has(linkCrypto)).toBe(true);
  });
});
