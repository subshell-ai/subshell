import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import {
  type ControlKeyPair,
  generateControlKeys,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeCommandBody,
  type NodeEvent,
  parseNodeEvent,
  signCommand,
} from "@internal/session-protocol";
import type { AgentConfig } from "../config.js";
import { type DaemonDeps, probeOnline, runDaemon, wsUrlFor } from "../daemon.js";
import { AGENT_VERSION } from "../version.js";

/**
 * The daemon under a fake control plane. The plane is a real `Bun.serve` ws
 * endpoint: the daemon dials it with its bearer header (proving the client
 * options cast works at runtime), and EVERY outbound frame the agent sends is
 * parsed with the real `parseNodeEvent` — that is the wire contract test
 * (the backend's node-ws-handler parses inbound frames the same way).
 */

const NODE_ID = "test-node-1";
const NODE_KEY = "mote_node_key_never_printed";

/** Thrown by the injected `exit` so `runDaemon` returns instead of killing the test process. */
class DaemonStopped extends Error {
  constructor(public readonly code: number) {
    super(`daemon exited with ${code}`);
  }
}

const keysReady: Promise<ControlKeyPair> = generateControlKeys();
/** A second ES256 pair the daemon does NOT trust — signs "hostile" envelopes. */
const hostileKeysReady: Promise<ControlKeyPair> = generateControlKeys();

interface PlaneSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Plane {
  server: ReturnType<typeof Bun.serve>;
  events: NodeEvent[];
  /** Frames the agent sent that the REAL parseNodeEvent rejected (contract violations). */
  unparsed: string[];
  opens: number;
  closes: number;
  /** Most recently opened socket (the daemon's, unless a probe was last). */
  socket?: PlaneSocket;
  /** EVERY currently-open socket — teardown 4409s all of them, probes included. */
  sockets: Set<PlaneSocket>;
}

interface Harness {
  plane: Plane;
  config: AgentConfig;
  keys: ControlKeyPair;
  hostileKeys: ControlKeyPair;
  /** Codes the injected exit() captured (terminal 4409/4406 → 1; SIGINT → 0). */
  exits: number[];
  /** Resolves when runDaemon settles (DaemonStopped expected; anything else is a bug). */
  stopped: Promise<void>;
  /** Non-DaemonStopped rejection — surfaced by waitFor so failures are legible. */
  fatal?: unknown;
}

let active: Harness | undefined;

function startPlane(): Plane {
  const plane: Plane = {
    server: undefined as unknown as ReturnType<typeof Bun.serve>,
    events: [],
    unparsed: [],
    opens: 0,
    closes: 0,
    sockets: new Set(),
  };
  plane.server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname !== "/ws/node") return new Response("not found", { status: 404 });
      // Mirrors the real upgrade hook: a bad bearer never gets a socket.
      if (req.headers.get("authorization") !== `Bearer ${NODE_KEY}`)
        return new Response("unauthorized", { status: 401 });
      return server.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        plane.opens++;
        const sock = ws as unknown as PlaneSocket;
        plane.socket = sock;
        plane.sockets.add(sock);
      },
      message(_ws, msg) {
        const text = typeof msg === "string" ? msg : msg.toString();
        const ev = parseNodeEvent(text); // the REAL validator — agent frames must be parseable by the backend
        if (ev) plane.events.push(ev);
        else plane.unparsed.push(text.slice(0, 200));
      },
      close(ws) {
        plane.closes++;
        const sock = ws as unknown as PlaneSocket;
        plane.sockets.delete(sock);
        if (plane.socket === sock) plane.socket = undefined;
      },
    },
  });
  return plane;
}

/** Terminal-close every open socket (the daemon's escape hatch in tests). */
function closeAllSockets(plane: Plane, code: number, reason: string): void {
  for (const s of [...plane.sockets]) {
    try {
      s.close(code, reason);
    } catch {
      /* already gone */
    }
  }
}

async function startDaemon(overrides: Partial<Pick<DaemonDeps, "heartbeatMs" | "rand">> = {}): Promise<Harness> {
  const [keys, hostileKeys] = await Promise.all([keysReady, hostileKeysReady]);
  const plane = startPlane();
  const config: AgentConfig = {
    serverUrl: `http://localhost:${plane.server.port}`,
    nodeId: NODE_ID,
    nodeKey: NODE_KEY,
    controlPublicKey: JSON.stringify(keys.publicJwk),
    dataDir: "/tmp/mote-agent-test-data",
    name: "test-node",
  };
  const exits: number[] = [];
  const h: Harness = { plane, config, keys, hostileKeys, exits, stopped: Promise.resolve() };
  const promise = runDaemon(config, {
    rand: () => 0, // zero-jitter → instant reconnects (tests must not wait out backoff)
    heartbeatMs: 3_600_000, // interval effectively off; the heartbeat test overrides
    exit: (code: number): never => {
      exits.push(code);
      throw new DaemonStopped(code);
    },
    ...overrides,
  });
  h.stopped = promise.then(
    () => undefined,
    (err: unknown) => {
      if (!(err instanceof DaemonStopped)) h.fatal = err;
    },
  );
  active = h;
  await waitForReady(h);
  if (h.fatal) throw h.fatal;
  return h;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function eventTypes(h: Harness): string[] {
  return h.plane.events.map((e) => e.type);
}

/** Poll until a received event matches, else fail with what DID arrive. */
async function waitFor<T extends NodeEvent>(
  h: Harness,
  pred: (e: NodeEvent) => boolean,
  what: string,
  timeoutMs = 4000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    if (h.fatal) throw h.fatal;
    const found = h.plane.events.find(pred);
    if (found) return found as T;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timed out waiting for ${what}; received: ${JSON.stringify(eventTypes(h))}`);
    }
    await sleep(5);
  }
}

function waitForReady(h: Harness): Promise<NodeEvent> {
  return waitFor(h, (e) => e.type === "ready", "ready frame");
}

async function signAndSend(
  h: Harness,
  cmd: NodeCommandBody,
  opts: { jti: string; seq: number; hostile?: boolean } | undefined = undefined,
): Promise<string> {
  const jti = opts?.jti ?? `jti-${Math.random().toString(36).slice(2)}`;
  const seq = opts?.seq ?? h.plane.events.filter((e) => e.type === "result").length + 1;
  const priv = opts?.hostile ? h.hostileKeys.privateJwk : h.keys.privateJwk;
  const jws = await signCommand(priv, { nodeId: NODE_ID, jti, seq, cmd });
  if (!h.plane.socket) throw new Error("plane has no live socket");
  h.plane.socket.send(JSON.stringify({ jws }));
  return jti;
}

/** Count how many times a predicate matches (used as the execution spy). */
function count(h: Harness, pred: (e: NodeEvent) => boolean): number {
  return h.plane.events.filter(pred).length;
}

afterEach(async () => {
  const h = active;
  if (!h) return;
  active = undefined;
  // Drive the daemon out through the terminal path so its loop stops for good.
  closeAllSockets(h.plane, 4409, "test teardown");
  await Promise.race([h.stopped, sleep(1500)]);
  h.plane.server.stop(true);
});

/* ------------------------------------------------------------------ */

test("wsUrlFor derives wss/ws + /ws/node from the server URL", () => {
  expect(wsUrlFor("https://mote.example")).toBe("wss://mote.example/ws/node");
  expect(wsUrlFor("https://mote.example:5173")).toBe("wss://mote.example:5173/ws/node");
  expect(wsUrlFor("http://localhost:4000")).toBe("ws://localhost:4000/ws/node");
});

test("sends a ready frame the real parseNodeEvent accepts, with protocol identity", async () => {
  const h = await startDaemon();
  const ready = await waitForReady(h);
  expect(ready).toMatchObject({
    type: "ready",
    agentVersion: AGENT_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    arch: process.arch,
    hostname: hostname(),
    dataDir: h.config.dataDir,
    capabilities: [],
  });
  const os = (ready as Extract<NodeEvent, { type: "ready" }>).os;
  expect(["linux", "darwin", "unknown"]).toContain(os);
  expect(h.plane.unparsed).toEqual([]); // every frame so far satisfies the backend's parser
});

test("valid ping (test-local EC keypair pinned in config) → result ok with matching ref", async () => {
  const h = await startDaemon();
  const jti = await signAndSend(h, { type: "ping" }, { jti: "ping-1", seq: 1 });
  const result = await waitFor<Extract<NodeEvent, { type: "result" }>>(h, (e) => e.type === "result", "result frame");
  expect(result.ref).toBe(jti);
  expect(result.ok).toBe(true);
  expect(h.plane.unparsed).toEqual([]);
});

test("frame signed by an unknown key → verify error event, NO result", async () => {
  const h = await startDaemon();
  await signAndSend(h, { type: "ping" }, { jti: "evil-1", seq: 1, hostile: true });
  const err = await waitFor<Extract<NodeEvent, { type: "error" }>>(h, (e) => e.type === "error", "error frame");
  expect(err).toMatchObject({ code: "verify", message: "signature" });
  // The heart of the brief: a bad signature is ignored for EXECUTION purposes — no result frame ever appears.
  await sleep(100);
  expect(count(h, (e) => e.type === "result")).toBe(0);
});

test("launch (valid wire, unimplemented) → result ok:false unsupported", async () => {
  const h = await startDaemon();
  const launch: NodeCommandBody = {
    type: "launch",
    sessionId: "s1",
    socket: "mote-s1",
    cwd: "/tmp",
    harnessId: "claude-code",
    profile: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    moteEnv: {},
    sessionName: "s1",
  };
  const jti = await signAndSend(h, launch, { jti: "launch-1", seq: 1 });
  const result = await waitFor<Extract<NodeEvent, { type: "result" }>>(h, (e) => e.type === "result", "result");
  expect(result.ref).toBe(jti);
  expect(result).toMatchObject({ ok: false, error: "unsupported" });
});

test("inventory command: inventory EVENT first, then result ok; harness list well-formed", async () => {
  const h = await startDaemon();
  const jti = await signAndSend(h, { type: "inventory" }, { jti: "inv-1", seq: 1 });
  const result = await waitFor<Extract<NodeEvent, { type: "result" }>>(
    h,
    (e) => e.type === "result",
    "inventory result",
  );
  const types = eventTypes(h);
  const invIdx = types.indexOf("inventory");
  expect(invIdx).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("result")).toBeGreaterThan(invIdx); // event-then-result ordering
  const inv = h.plane.events[invIdx] as Extract<NodeEvent, { type: "inventory" }>;
  expect(Array.isArray(inv.harnesses)).toBe(true);
  expect(inv.harnesses.length).toBeGreaterThan(0);
  expect(typeof inv.ts).toBe("string");
  expect(result).toMatchObject({ ref: jti, ok: true });
});

test("replayed jti: exactly one execution (spy), one result, silence — no second result", async () => {
  const h = await startDaemon();
  // Sign ONE envelope and deliver it twice — the jti LRU must drop the second.
  const jws = await signCommand(h.keys.privateJwk, {
    nodeId: NODE_ID,
    jti: "replay-1",
    seq: 1,
    cmd: { type: "inventory" },
  });
  h.plane.socket?.send(JSON.stringify({ jws }));
  await waitFor(h, (e) => e.type === "inventory", "first inventory execution");
  h.plane.socket?.send(JSON.stringify({ jws }));
  await sleep(150); // give a double execution every chance to show up
  expect(count(h, (e) => e.type === "inventory")).toBe(1); // handler spy: executed ONCE
  expect(count(h, (e) => e.type === "result" && e.ref === "replay-1")).toBe(1);
  expect(count(h, (e) => e.type === "error")).toBe(0); // replay path is SILENCE (ruling)
});

test("close 4409 (superseded) is terminal: exit injection fires with 1, loop stops", async () => {
  const h = await startDaemon();
  h.plane.socket?.close(4409, "duplicate connection");
  const deadline = Date.now() + 2000;
  while (h.exits.length === 0 && Date.now() < deadline) await sleep(5);
  expect(h.exits).toEqual([1]);
  await h.stopped; // rejects via DaemonStopped → captured in stopped, fatal stays clear
  expect(h.fatal).toBeUndefined();
  // And the loop is GONE: no reconnect, no third open.
  const opens = h.plane.opens;
  await sleep(100);
  expect(h.plane.opens).toBe(opens);
});

test("close 4406 (update required) is terminal too", async () => {
  const h = await startDaemon();
  h.plane.socket?.close(4406, "agent update required");
  const deadline = Date.now() + 2000;
  while (h.exits.length === 0 && Date.now() < deadline) await sleep(5);
  expect(h.exits).toEqual([1]);
});

test("seq regression: error event, socket dropped, fresh SeqTracker on the reconnect", async () => {
  const h = await startDaemon();
  await signAndSend(h, { type: "ping" }, { jti: "seq-5", seq: 5 });
  await waitFor(h, (e) => e.type === "result" && e.ref === "seq-5", "seq-5 result");
  const closesBefore = h.plane.closes;
  await signAndSend(h, { type: "ping" }, { jti: "seq-3", seq: 3 }); // regression
  const err = await waitFor<Extract<NodeEvent, { type: "error" }>>(
    h,
    (e) => e.type === "error" && e.code === "verify" && e.message === "seq",
    "seq verify error",
  );
  expect(err).toBeTruthy();
  // The drop itself: plane sees the close, then a RECONNECT (open #2, ready #2).
  const closeDeadline = Date.now() + 2000;
  while (h.plane.closes === closesBefore && Date.now() < closeDeadline) await sleep(5);
  await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
  // A FRESH SeqTracker: seq 1 is now acceptable on the new connection.
  await signAndSend(h, { type: "ping" }, { jti: "seq-1", seq: 1 });
  await waitFor(h, (e) => e.type === "result" && e.ref === "seq-1", "post-reconnect ping result");
});

test("oversize inbound frame is ignored (no close, no error frame); connection survives", async () => {
  const h = await startDaemon();
  const oversize = JSON.stringify({ jws: "x".repeat(NODE_MAX_FRAME_BYTES + 10_000) });
  h.plane.socket?.send(oversize);
  await sleep(100);
  expect(count(h, (e) => e.type === "error")).toBe(0); // ignored + logged, NOT answered
  expect(h.plane.closes).toBe(0); // NOT closed (ruling: oversize inbound = hostile noise)
  const jti = await signAndSend(h, { type: "ping" }, { jti: "after-big", seq: 1 });
  await waitFor(h, (e) => e.type === "result" && e.ref === jti, "ping result after oversize frame");
});

test("heartbeat frames flow on the injected interval", async () => {
  const h = await startDaemon({ heartbeatMs: 30 });
  const deadline = Date.now() + 3000;
  while (count(h, (e) => e.type === "heartbeat") < 2 && Date.now() < deadline) await sleep(10);
  const hb = h.plane.events.find((e) => e.type === "heartbeat") as Extract<NodeEvent, { type: "heartbeat" }>;
  expect(typeof hb.ts).toBe("string");
  expect(Number.isNaN(Date.parse(hb.ts))).toBe(false);
});

test("probeOnline: true against a live plane, false against a refused key / dead port", async () => {
  const h = await startDaemon();
  await expect(probeOnline(h.config)).resolves.toBe(true); // socket opened → online
  await expect(probeOnline({ ...h.config, nodeKey: "wrong" })).resolves.toBe(false); // 401 at upgrade
  const deadPort = h.plane.server.port;
  closeAllSockets(h.plane, 4409, "teardown early"); // stop this daemon before killing the plane
  await Promise.race([h.stopped, sleep(1500)]);
  h.plane.server.stop(true);
  await expect(probeOnline({ ...h.config, serverUrl: `http://localhost:${deadPort}` })).resolves.toBe(false);
});

test("a wrong bearer key never gets a socket (upgrade refused)", async () => {
  const plane = startPlane();
  const [keys] = await Promise.all([keysReady]);
  const config: AgentConfig = {
    serverUrl: `http://localhost:${plane.server.port}`,
    nodeId: NODE_ID,
    nodeKey: "wrong-key",
    controlPublicKey: JSON.stringify(keys.publicJwk),
    dataDir: "/tmp/mote-agent-test-data",
    name: "test-node",
  };
  const exits: number[] = [];
  let refusedLoop = false;
  const promise = runDaemon(config, {
    // Trap: the FIRST refused connect lands in the backoff path; throwing from
    // rand() ends the loop (a 401 retry loop would otherwise hammer the plane
    // for the rest of the suite).
    rand: (): number => {
      refusedLoop = true;
      throw new DaemonStopped(0);
    },
    exit: (code: number): never => {
      exits.push(code);
      throw new DaemonStopped(code);
    },
  });
  promise.catch(() => undefined);
  const deadline = Date.now() + 2000;
  while (!refusedLoop && Date.now() < deadline) await sleep(5);
  expect(refusedLoop).toBe(true); // it DID try (and the plane said 401)
  expect(plane.opens).toBe(0); // refused at the HTTP upgrade — never attached
  expect(exits).toEqual([]); // a refused upgrade is NOT terminal: it took the backoff path
  plane.server.stop(true);
});
