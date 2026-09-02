import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxRunner } from "@internal/harnesses";
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
import { run as runCli } from "../cli.js";
import { TAIL_BACKSTOP_MS } from "../commands/tail.js";
import { type AgentConfig, saveConfig } from "../config.js";
import { type DaemonDeps, probeOnline, runDaemon, type WsConstructor, type WsLike, wsUrlFor } from "../daemon.js";
import { type DaemonLock, lockPath } from "../lock.js";
import { SessionMetaStore } from "../session-meta.js";
import { newHome } from "../test-preload.js";
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

async function startDaemon(
  overrides: Partial<Pick<DaemonDeps, "heartbeatMs" | "inventoryMs" | "rand" | "tmux" | "meta" | "WebSocketImpl">> = {},
): Promise<Harness> {
  const [keys, hostileKeys] = await Promise.all([keysReady, hostileKeysReady]);
  const plane = startPlane();
  const config: AgentConfig = {
    serverUrl: `http://localhost:${plane.server.port}`,
    nodeId: NODE_ID,
    nodeKey: NODE_KEY,
    controlPublicKey: JSON.stringify(keys.publicJwk),
    dataDir: "/tmp/subshell-test-data",
    name: "test-node",
  };
  const exits: number[] = [];
  const h: Harness = { plane, config, keys, hostileKeys, exits, stopped: Promise.resolve() };
  const promise = runDaemon(config, {
    rand: () => 0, // zero-jitter → instant reconnects (tests must not wait out backoff)
    heartbeatMs: 3_600_000, // interval effectively off; the heartbeat test overrides
    inventoryMs: 3_600_000, // periodic push effectively off; the P3-T8c tests override (the inventory COMMAND tests count frames against the connect-push baseline)
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

/** All events of one type, narrowed (so `.ref`/`.message` are typed in assertions). */
function eventsAs<T extends NodeEvent["type"]>(h: Harness, type: T): Extract<NodeEvent, { type: T }>[] {
  return h.plane.events.filter((e): e is Extract<NodeEvent, { type: T }> => e.type === type);
}

/** Parse the daemon lock — THROWS when absent/corrupt (a legible test failure, not a silent null). */
function lockFileOrThrow(): DaemonLock {
  return JSON.parse(readFileSync(lockPath(), "utf8")) as DaemonLock;
}

/** Sign ONE envelope; deliver it on the plane's live socket; return the bytes for re-delivery. */
async function signEnvelope(h: Harness, cmd: NodeCommandBody, jti: string, seq: number): Promise<string> {
  const jws = await signCommand(h.keys.privateJwk, { nodeId: NODE_ID, jti, seq, cmd });
  return JSON.stringify({ jws });
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

// Ledger 17c (P1-T12 carry): enroll persists the SERVER-REPORTED ws URL; the
// daemon must prefer it over the derived one (behind a divergent proxy the
// derived URL targets the alias, not the plane that answered enroll). A
// WebSocket ctor that records the dial URL and throws proves exactly what
// `runDaemon` dials — no plane needed (the ctor throw unwinds the loop).
test("runDaemon dials the persisted nodeWsUrl; old configs still dial the derived URL", async () => {
  newHome();
  const [keys] = await Promise.all([keysReady]);
  const dialed: string[] = [];
  const RecordingWs = function (this: never, url: string) {
    dialed.push(url);
    throw new Error("dial intercepted");
  } as unknown as WsConstructor;
  const base = {
    nodeId: NODE_ID,
    nodeKey: NODE_KEY,
    controlPublicKey: JSON.stringify(keys.publicJwk),
    dataDir: "/tmp/subshell-test-data",
    name: "test-node",
  };

  await expect(
    runDaemon(
      { ...base, serverUrl: "https://control.example", nodeWsUrl: "wss://pin.example/ws/node" },
      { WebSocketImpl: RecordingWs },
    ),
  ).rejects.toThrow(/cannot open wss:\/\/pin\.example\/ws\/node/);
  expect(dialed).toEqual(["wss://pin.example/ws/node"]);

  // Absent persisted URL (config from before 17c) ⇒ the derived path, verbatim.
  dialed.length = 0;
  await expect(
    runDaemon({ ...base, serverUrl: "https://control.example" }, { WebSocketImpl: RecordingWs }),
  ).rejects.toThrow(/cannot open wss:\/\/control\.example\/ws\/node/);
  expect(dialed).toEqual(["wss://control.example/ws/node"]);
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
    // Phase 2 (Task 4): the capability set advertises the phase-2 command
    // surface; Task 13 shipped the `mcp` subcommand, so `mcp` is advertised
    // alongside `uploads` (this list is what the backend's capability gate reads).
    capabilities: ["uploads", "mcp"],
    // Task 1's additive field: the control plane composes the MCP spec against it.
    executablePath: process.execPath,
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

// Task 4 flipped `launch` to the real executor. The end-to-end meaning of
// this case is kept — a signed launch frame reaches the dispatcher and its
// answer comes back as a result frame with the matching ref — answered here
// through the id-format gate so NO tmux/spawn side effect can happen on the
// test host (the launch happy path is covered in commands-launch.test.ts).
test("launch (valid wire, hostile session id) → result ok:false invalid session id", async () => {
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
  expect(result).toMatchObject({ ok: false, error: "invalid session id" });
});

test("inventory command: inventory EVENT first, then result ok; harness list well-formed", async () => {
  const h = await startDaemon();
  await waitFor(h, (e) => e.type === "inventory", "connect inventory push"); // P3-T8b: the push precedes the command
  const jti = await signAndSend(h, { type: "inventory" }, { jti: "inv-1", seq: 1 });
  const result = await waitFor<Extract<NodeEvent, { type: "result" }>>(
    h,
    (e) => e.type === "result",
    "inventory result",
  );
  const types = eventTypes(h);
  const invIdx = types.lastIndexOf("inventory"); // the COMMAND's event (the connect push already landed earlier)
  expect(invIdx).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("result", invIdx)).toBeGreaterThan(invIdx); // event-then-result ordering
  expect(count(h, (e) => e.type === "inventory")).toBe(2); // connect push + command answer
  const inv = h.plane.events[invIdx] as Extract<NodeEvent, { type: "inventory" }>;
  expect(Array.isArray(inv.harnesses)).toBe(true);
  expect(inv.harnesses.length).toBeGreaterThan(0);
  expect(typeof inv.ts).toBe("string");
  expect(result).toMatchObject({ ref: jti, ok: true });
});

test("replayed jti (same connection): ONE execution (spy), verify/replay error event, cached result re-sent", async () => {
  const h = await startDaemon();
  // Sign ONE envelope and deliver it twice — the jti LRU must drop the second EXECUTION,
  // but the brief (§4) wants the anomaly VISIBLE: every verify failure, replay included,
  // answers the error event (fix wave 1; this replaces the old "replay → silence" ruling).
  await waitFor(h, (e) => e.type === "inventory", "connect inventory push"); // P3-T8b: baseline past the connect beat
  const frame = await signEnvelope(h, { type: "inventory" }, "replay-1", 1);
  const invBefore = count(h, (e) => e.type === "inventory");
  h.plane.socket?.send(frame);
  await waitFor(h, (e) => e.type === "result" && e.ref === "replay-1", "first inventory execution");
  h.plane.socket?.send(frame);
  await sleep(150); // give a double execution every chance to show up
  expect(count(h, (e) => e.type === "inventory")).toBe(invBefore + 1); // handler spy: executed ONCE
  const errs = eventsAs(h, "error");
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatchObject({ code: "verify", message: "replay" });
  // The idempotence map is REACHABLE through the replay path: the double-delivery gets
  // its answer back — a duplicate result with the SAME ref and body, not a re-execution.
  const results = eventsAs(h, "result").filter((e) => e.ref === "replay-1");
  expect(results.length).toBe(2);
  expect(results[1]).toEqual(results[0]);
});

test("per-process jti LRU survives a reconnect: replay on the NEW socket → verify/replay telemetry, never a second execution", async () => {
  const h = await startDaemon();
  await waitFor(h, (e) => e.type === "inventory", "conn-1 connect push"); // P3-T8b: the beat precedes the command
  // conn 1: execute a signed inventory (jti "recon-1").
  const frame = await signEnvelope(h, { type: "inventory" }, "recon-1", 1);
  h.plane.socket?.send(frame);
  await waitFor(h, (e) => e.type === "result" && e.ref === "recon-1", "conn-1 result");
  expect(count(h, (e) => e.type === "inventory")).toBe(2); // conn-1 push + one command execution
  // NON-terminal close (1001) → the daemon reconnects (rand 0 → immediate).
  closeAllSockets(h.plane, 1001, "server restart");
  await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
  // The connect push RE-ARMS on the new socket (freshness gate re-applies after a reconnect).
  await waitFor(h, () => count(h, (e) => e.type === "inventory") >= 3, "conn-2 connect push");
  // conn 2: the plane REPLAYS the exact same signed envelope.
  h.plane.socket?.send(frame);
  await sleep(150);
  // A per-CONNECTION LRU (the mutation this test exists to catch) would pass verify here
  // and produce ZERO error events; the process-wide LRU must produce exactly the replay one.
  const errs = eventsAs(h, "error");
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatchObject({ code: "verify", message: "replay" });
  expect(count(h, (e) => e.type === "inventory")).toBe(3); // spy: no second evaluation on conn 2 (2 pushes + 1 execution)
  const results = eventsAs(h, "result").filter((e) => e.ref === "recon-1");
  expect(results.length).toBe(2); // first execution + idempotence-map re-send
  expect(h.plane.unparsed).toEqual([]);
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
    dataDir: "/tmp/subshell-test-data",
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

/* ------------------------------------------------------------------ */
/* Fix wave 1: signal during backoff + non-destructive status          */
/* ------------------------------------------------------------------ */

// Ledger 17e (P1-T13 Minor 3, CI-flake watch). The old design: one plane close
// → the FIRST backoff sleep, exactly 1000 ms (rand→1), asserting exit within
// 750 ms — only a 500 ms margin over the ≤250 ms slice budget, which CI load can
// eat. Determinism instead: a dead port means the loop never opens, so `attempt`
// climbs and the injected rand pins the ladder to EXACT delays (1000, 2000, …).
// The test parks in the 2000 ms step, so the raised 750→1500 ms window still
// DISCRIMINATES: a sliced sleep answers SIGINT in ≲250 ms + slop; an
// uninterruptible one would only exit at ~2000 ms — past every deadline here.
test("SIGINT during the backoff sleep: exits 0 inside the raised slice budget and never dials again", async () => {
  const [keys] = await Promise.all([keysReady]);
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" ")); // every daemon log line doubles as the dial counter
  });
  const exits: number[] = [];
  let fatal: unknown;
  const stopped = runDaemon(
    {
      serverUrl: "http://localhost:1", // refused instantly (same dead-port fixture status --probe uses)
      nodeId: NODE_ID,
      nodeKey: NODE_KEY,
      controlPublicKey: JSON.stringify(keys.publicJwk),
      dataDir: "/tmp/subshell-test-data",
      name: "test-node",
    },
    {
      rand: () => 1, // full jitter at its max: delay = min(60 s, 1000·2^attempt), exact — no randomness
      exit: (code: number): never => {
        exits.push(code);
        throw new DaemonStopped(code);
      },
    },
  ).then(
    () => undefined,
    (err: unknown) => {
      if (!(err instanceof DaemonStopped)) fatal = err;
    },
  );

  try {
    const inSecondSleep = "reconnecting in 2000 ms";
    const sleepDeadline = Date.now() + 6000; // first rung (1000 ms) + two instant ECONNREFUSEDs
    while (!lines.some((l) => l.includes(inSecondSleep)) && Date.now() < sleepDeadline) await sleep(10);
    expect(lines.some((l) => l.includes(inSecondSleep))).toBe(true); // we ARE inside the 2000 ms sleep

    const t0 = Date.now();
    process.kill(process.pid, "SIGINT"); // the daemon's handler is registered in this very process
    const exitDeadline = t0 + 1500;
    while (exits.length === 0 && Date.now() < exitDeadline) await sleep(5);
    expect(exits).toEqual([0]); // first Ctrl-C wins — the sliced sleep aborted the 2000 ms wait
    expect(Date.now() - t0).toBeLessThan(1500); // the ≤250 ms slice budget + generous slop, NOT the 2000 ms sleep
    await stopped;
    expect(fatal).toBeUndefined();

    // The loop is dead: no further dial/log after the exit. (The old plane.opens
    // freeze, ported to the dial-free ladder; the sleep-based no-dial assertion
    // is gone because exits[0] + a stopped loop already pin it — ledger 17e.)
    const frozen = lines.length;
    await sleep(300);
    expect(lines.length).toBe(frozen);
  } finally {
    spy.mockRestore();
  }
});

test("daemon.lock: written at startup, refreshed on heartbeat ticks, cleared on terminal exit", async () => {
  newHome(); // isolate the lock file from other tests (they share the preload home)
  const h = await startDaemon({ heartbeatMs: 30 });
  const lock = lockFileOrThrow();
  expect(lock.pid).toBe(process.pid);
  expect(lock.nodeId).toBe(NODE_ID);
  expect(Number.isNaN(Date.parse(lock.startedAt))).toBe(false);
  const firstTick = lock.lastTickAt;
  await sleep(120); // ~4 heartbeat ticks at 30 ms
  expect(lockFileOrThrow().lastTickAt).not.toBe(firstTick); // every tick refreshes lastTickAt
  closeAllSockets(h.plane, 4409, "terminal");
  const deadline = Date.now() + 2000;
  while (h.exits.length === 0 && Date.now() < deadline) await sleep(5);
  expect(h.exits).toEqual([1]);
  expect(existsSync(lockPath())).toBe(false); // cleared on the exit path (BEFORE exit fires)
});

test("status: a live daemon.lock reports ONLINE without touching the plane (destructiveness regression)", async () => {
  newHome();
  const h = await startDaemon();
  await saveConfig(h.config); // the CLI loads its config from the (fresh) agent home
  const opensBefore = h.plane.opens;
  const text = await runCli(["status"]);
  expect(text.code).toBe(0);
  expect(text.out).toInclude("ONLINE");
  expect(text.err).toBe("");
  const json = await runCli(["status", "--json"]);
  expect(json.code).toBe(0);
  const body = JSON.parse(json.out) as Record<string, unknown>;
  expect(body).toMatchObject({
    nodeId: NODE_ID,
    serverUrl: h.config.serverUrl,
    online: true,
    agentVersion: AGENT_VERSION,
  });
  expect(typeof body.daemonAgeMs).toBe("number"); // heartbeat age on the JSON path
  expect(body.probe).toBeUndefined(); // lock path never probes
  // THE regression: the old status dialed a probe socket and supersede-KICKED the agent.
  expect(h.plane.opens).toBe(opensBefore);
  // And the daemon survived its own status check:
  await signAndSend(h, { type: "ping" }, { jti: "after-status", seq: 1 });
  await waitFor(h, (e) => e.type === "result" && e.ref === "after-status", "ping after status");
});

test("status: stale lock (dead pid) is cleaned and OFFLINE without a probe; a foreign node's lock is left alone", async () => {
  newHome();
  const h = await startDaemon(); // its own startup lock gets overwritten below
  await saveConfig(h.config);
  const opensBefore = h.plane.opens;
  const DEAD_PID = 2_147_483_646; // beyond any pid_max on Linux: kill(pid, 0) is a guaranteed ESRCH
  const stamp = new Date().toISOString();
  writeFileSync(lockPath(), JSON.stringify({ pid: DEAD_PID, startedAt: stamp, nodeId: NODE_ID, lastTickAt: stamp }));
  const r = await runCli(["status"]);
  expect(r.code).toBe(1);
  expect(r.out).toInclude("OFFLINE");
  expect(existsSync(lockPath())).toBe(false); // stale lock cleaned up
  expect(h.plane.opens).toBe(opensBefore); // …and OFFLINE was answered LOCALLY — zero dials
  writeFileSync(
    lockPath(),
    JSON.stringify({ pid: process.pid, startedAt: stamp, nodeId: "some-other-node", lastTickAt: stamp }),
  );
  const r2 = await runCli(["status"]);
  expect(r2.code).toBe(1); // a live lock for ANOTHER node: neither trusted nor deleted
  expect(existsSync(lockPath())).toBe(true);
});

test("status --probe: explicit opt-in dials the plane with a loud stderr warning; no-lock default stays silent", async () => {
  newHome();
  const h = await startDaemon();
  await saveConfig(h.config);
  rmSync(lockPath(), { force: true }); // simulate "no local daemon" (the harness heartbeat is off)
  const opensBefore = h.plane.opens;
  const r = await runCli(["status", "--probe"]);
  expect(r.code).toBe(0);
  expect(r.out).toInclude("ONLINE");
  expect(r.err).toInclude("KICKS"); // the loud warning ships with every --probe invocation
  expect(h.plane.opens).toBe(opensBefore + 1); // the probe DID dial (opt-in destructiveness)
  const body = JSON.parse((await runCli(["status", "--probe", "--json"])).out) as Record<string, unknown>;
  expect(body.online).toBe(true);
  expect(body.probe).toBe(true); // probe verdict is labelled
  expect(body.daemonAgeMs).toBeUndefined(); // probe path knows nothing about a local daemon
  // No lock + NO --probe → honest OFFLINE, no dial, no warning:
  const off = await runCli(["status"]);
  expect(off.code).toBe(1);
  expect(off.err).toBe("");
  expect(off.out).toInclude("OFFLINE");
  // Probe against a dead port → refusal is a clean offline, still labelled.
  await saveConfig({ ...h.config, serverUrl: "http://localhost:1" });
  const dead = await runCli(["status", "--probe", "--json"]);
  expect(dead.code).toBe(1);
  const deadBody = JSON.parse(dead.out) as Record<string, unknown>;
  expect(deadBody.online).toBe(false);
  expect(deadBody.probe).toBe(false);
});

/* ------------------------------------------------------------------ */
/* Phase 2 Task 3: serial executor + outbound frame guard (spec §3.4)  */
/* ------------------------------------------------------------------ */

const HEX_A = "00000000-0000-4000-8000-00000000000a";
const HEX_B = "00000000-0000-4000-8000-00000000000b";

test("commands run SERIALLY in arrival order (spec §3.4): the second starts only after the first's promise resolves", async () => {
  // The first command (terminate) is made slow INSIDE its await (the meta
  // lookup); the second (input) is instant. With the old per-message
  // `void onFrame(...)` they interleave — input lands while terminate is
  // still parked — so the exact order array is the serialization proof.
  const order: string[] = [];
  const fakeTmux = {
    run: () => {
      order.push("terminate:end"); // the kill-session call — the first command's effect
      return { stdout: "", stderr: "" };
    },
    sendInput: () => {
      order.push("input:start"); // the second command's start
    },
  } as unknown as TmuxRunner;
  const slowMeta = {
    get: async (id: string) => {
      if (id === HEX_A) {
        order.push("terminate:start");
        await sleep(60);
        order.push("terminate:awaited");
      }
      return undefined;
    },
    // The connect-time sessions_report scan needs it too — without `list` every
    // connect logs "sessions_report failed" noise around this test.
    list: async () => [],
  } as unknown as SessionMetaStore;
  const h = await startDaemon({ tmux: fakeTmux, meta: slowMeta });
  const jtiT = await signAndSend(h, { type: "terminate", sessionId: HEX_A }, { jti: "ser-t", seq: 1 });
  const jtiI = await signAndSend(h, { type: "input", sessionId: HEX_B, data: "x" }, { jti: "ser-i", seq: 2 });
  await waitFor(h, (e) => e.type === "result" && e.ref === jtiI, "input result");
  // The second's start FOLLOWS the first's end — strict serial, arrival order.
  expect(order).toEqual(["terminate:start", "terminate:awaited", "terminate:end", "input:start"]);
  // …and the result frames carry the same order.
  const refs = eventsAs(h, "result").map((e) => e.ref);
  expect(refs.indexOf(jtiT)).toBeLessThan(refs.indexOf(jtiI));
  expect(h.plane.unparsed).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Phase 2 Task 4: connect-time sessions_report (spec §3.3)            */
/* ------------------------------------------------------------------ */

test("sessions_report lands AFTER ready: one row per recorded meta, re-projection on connect", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mote-daemon-report-"));
  const store = new SessionMetaStore(dataDir); // simulates panes that survived an agent restart
  await store.record({
    sessionId: HEX_A,
    cwd: dataDir,
    socket: "rep-sock",
    harnessId: "pi",
    name: "a",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  await store.record({
    sessionId: HEX_B,
    cwd: dataDir,
    socket: "rep-sock",
    harnessId: "pi",
    name: "b",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const fakeTmux = {
    hasSession: (_socket: string, id: string) => id === HEX_A,
    paneExitCode: () => 5,
  } as unknown as TmuxRunner;
  try {
    const h = await startDaemon({ tmux: fakeTmux, meta: store });
    const report = await waitFor<Extract<NodeEvent, { type: "sessions_report" }>>(
      h,
      (e) => e.type === "sessions_report",
      "sessions_report frame",
    );
    const types = eventTypes(h);
    expect(types.indexOf("sessions_report")).toBeGreaterThan(types.indexOf("ready")); // after ready (spec §3.3)
    expect(report.sessions).toEqual([
      { sessionId: HEX_A, alive: true, exitCode: null },
      { sessionId: HEX_B, alive: false, exitCode: 5 },
    ]);
    expect(h.plane.unparsed).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P3-T8b: connect-time initial inventory push (spec §7)                */
/* ------------------------------------------------------------------ */

test("connect pushes an inventory snapshot AFTER sessions_report: a fresh node launches without a manual recheck", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mote-daemon-invpush-"));
  const store = new SessionMetaStore(dataDir);
  await store.record({
    sessionId: HEX_A,
    cwd: dataDir,
    socket: "inv-sock",
    harnessId: "pi",
    name: "a",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const fakeTmux = {
    hasSession: () => true,
    paneExitCode: () => null,
  } as unknown as TmuxRunner;
  try {
    const h = await startDaemon({ tmux: fakeTmux, meta: store });
    const inv = await waitFor<Extract<NodeEvent, { type: "inventory" }>>(
      h,
      (e) => e.type === "inventory",
      "connect inventory frame",
    );
    // The beat pinned (P3-T8b): ready → sessions_report → inventory. The backend
    // reconcile applies the census's exits BEFORE the snapshot lands, so the
    // inventory must never overtake the report.
    const types = eventTypes(h);
    expect(types.indexOf("sessions_report")).toBeGreaterThan(types.indexOf("ready"));
    expect(types.indexOf("inventory")).toBeGreaterThan(types.indexOf("sessions_report"));
    expect(Array.isArray(inv.harnesses)).toBe(true);
    expect(inv.harnesses.length).toBeGreaterThan(0); // same builder the `inventory` command answers with
    expect(typeof inv.ts).toBe("string");
    expect(h.plane.unparsed).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a throwing sessions_report scan is catch-logged, never fatal to the connection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mote-daemon-report-fail-"));
  const store = new SessionMetaStore(dataDir);
  await store.record({
    sessionId: HEX_A,
    cwd: dataDir,
    socket: "x",
    harnessId: "pi",
    name: "a",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const fakeTmux = {
    hasSession: () => {
      throw new Error("tmux exploded");
    },
  } as unknown as TmuxRunner;
  try {
    const h = await startDaemon({ tmux: fakeTmux, meta: store });
    const jti = await signAndSend(h, { type: "ping" }, { jti: "after-report-fail", seq: 1 });
    await waitFor(h, (e) => e.type === "result" && e.ref === jti, "ping result after a failed report scan");
    expect(count(h, (e) => e.type === "sessions_report")).toBe(0); // the scan failed, so no frame — and no close
    // P3-T8b: the initial inventory push is INDEPENDENT of the census outcome —
    // a failed scan must still leave the node launchable (the push chains after
    // the report's catch, not after its success).
    await waitFor(h, (e) => e.type === "inventory", "inventory after a failed report scan");
    expect(h.plane.closes).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P3-T8c: periodic inventory push while connected (spec §7)           */
/* ------------------------------------------------------------------ */

/**
 * Wrap the REAL client WebSocket per dial: every send the daemon ATTEMPTS on
 * that connection is recorded on the instance before it throws or delegates,
 * and `state.throwOnSend` flips every later send into a throw. `sockets` keeps
 * the instances in dial order (sockets[0] = connection 1), so a test can ask
 * the leak question directly — did pushes keep going into the DEAD socket
 * after its close? — which plane-side event counts cannot answer (the dead
 * socket delivers nothing).
 */
function wrapRealWs(sockets: Array<{ sends: string[] }>, state: { throwOnSend: boolean }): WsConstructor {
  const Real = globalThis.WebSocket as unknown as new (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => WsLike;
  class Wrapped {
    readonly sends: string[] = [];
    private readonly inner: WsLike;
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.inner = new Real(url, opts);
      sockets.push(this);
    }
    get readyState(): number {
      return this.inner.readyState;
    }
    send(data: string): void {
      this.sends.push(data);
      if (state.throwOnSend) throw new Error("ws.send exploded");
      this.inner.send(data);
    }
    close(code?: number, reason?: string): void {
      this.inner.close(code, reason);
    }
    addEventListener(type: string, listener: (event?: unknown) => void): void {
      const add = this.inner.addEventListener as unknown as (t: string, l: unknown) => void;
      add.call(this.inner, type, listener);
    }
  }
  return Wrapped as unknown as WsConstructor;
}

/** How many of a wrapped socket's recorded sends were `inventory` events. */
function inventorySendCount(sock: { sends: string[] } | undefined): number {
  if (!sock) return 0;
  return sock.sends.filter((s) => {
    try {
      return (JSON.parse(s) as { type?: string }).type === "inventory";
    } catch {
      return false;
    }
  }).length;
}

test("periodic inventory: ticks push on the interval; close clears the loop; the reconnect arms exactly one", async () => {
  const sockets: Array<{ sends: string[] }> = [];
  const h = await startDaemon({ inventoryMs: 40, WebSocketImpl: wrapRealWs(sockets, { throwOnSend: false }) });
  // Connect push + two periodic ticks (T8b pinned the beat's existence and
  // order; this pins that it REPEATS and lands on the live socket).
  await waitFor(h, () => count(h, (e) => e.type === "inventory") >= 3, "two periodic inventory ticks");
  expect(inventorySendCount(sockets[0])).toBeGreaterThanOrEqual(3);

  // Non-terminal close → finish() tears the loop down → reconnect re-arms on the NEW socket.
  closeAllSockets(h.plane, 1001, "server restart");
  await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
  await waitFor(h, () => count(h, (e) => e.type === "inventory") >= 5, "connect push + tick on the new socket");
  expect(sockets.length).toBe(2); // exactly one fresh dial armed the second loop
  // Snapshot AFTER the reconnect: the old timer is already cleared by finish(),
  // so this is leak-or-no-more, with no close/tick race window.
  const staleBefore = inventorySendCount(sockets[0]);
  const newBefore = inventorySendCount(sockets[1]);
  await sleep(160); // ≥ 4 tick periods at 40 ms
  expect(inventorySendCount(sockets[0])).toBe(staleBefore); // cleared on disconnect — no pushing into a dead socket
  expect(inventorySendCount(sockets[1])).toBeGreaterThan(newBefore); // the new connection's ONE loop is alive
});

test("a throwing send does not kill the periodic loop: later ticks still deliver", async () => {
  const state = { throwOnSend: false };
  const sockets: Array<{ sends: string[] }> = [];
  const h = await startDaemon({ inventoryMs: 40, WebSocketImpl: wrapRealWs(sockets, state) });
  await waitFor(h, () => count(h, (e) => e.type === "inventory") >= 2, "connect push + first tick");
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  state.throwOnSend = true;
  await sleep(160); // several ticks whose sends throw — every one must be swallowed + logged
  const before = count(h, (e) => e.type === "inventory");
  state.throwOnSend = false;
  await waitFor(h, () => count(h, (e) => e.type === "inventory") > before, "a tick after the send recovered");
  spy.mockRestore();
  expect(h.plane.closes).toBe(0); // a failed push costs a log line, never the connection
  expect(lines.some((l) => l.includes("send inventory failed"))).toBe(true);
});

test("outbound guard: an oversize result is suppressed + logged, never sent; the link survives", async () => {
  const fakeTmux = {
    capturePane: () => "x".repeat(NODE_MAX_FRAME_BYTES), // result frame exceeds the 1 MiB cap
  } as unknown as TmuxRunner;
  const h = await startDaemon({ tmux: fakeTmux });
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  const jti = await signAndSend(h, { type: "capture", sessionId: HEX_A }, { jti: "big-1", seq: 1 });
  await sleep(100);
  spy.mockRestore();
  // Mirrors the inbound rule: suppress, do NOT close.
  expect(count(h, (e) => e.type === "result" && e.ref === jti)).toBe(0);
  expect(h.plane.closes).toBe(0);
  // (the suppressed frame is the RESULT frame — `ev.type` is "result")
  expect(lines.some((l) => l.includes("oversize result event suppressed"))).toBe(true);
  // The daemon is healthy behind the suppressed frame:
  const jti2 = await signAndSend(h, { type: "ping" }, { jti: "after-big", seq: 2 });
  await waitFor(h, (e) => e.type === "result" && e.ref === jti2, "ping after a suppressed capture");
});

/* ------------------------------------------------------------------ */
/* Phase 2 Task 5: tails die with the socket they stream into          */
/* ------------------------------------------------------------------ */

test("socket close stops every live tail: no output into the dead ws, none resurrected on reconnect", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mote-daemon-tail-"));
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const store = new SessionMetaStore(dataDir);
  const file = store.logPath(HEX_A);
  writeFileSync(file, "abc");
  try {
    const h = await startDaemon({ meta: store });
    await signAndSend(
      h,
      { type: "tail_start", sessionId: HEX_A, subId: "d-1", fromByte: 0 },
      { jti: "tail-1", seq: 1 },
    );
    const out = await waitFor<Extract<NodeEvent, { type: "output" }>>(h, (e) => e.type === "output", "tail output");
    expect(out).toMatchObject({ subId: "d-1", sessionId: HEX_A, fromByte: 0, toByte: 3 });

    // Non-terminal close → finish() drains ctx.tails (stopAllTails) → reconnect.
    closeAllSockets(h.plane, 1001, "server restart");
    await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
    appendFileSync(file, "de");
    // Outlast the backstop window: a surviving pump WOULD have delivered —
    // tails must never push into a dead ws, and the daemon must not auto-resume
    // subscriptions (the control plane re-`tail_start`s with its own cursors).
    await sleep(TAIL_BACKSTOP_MS + 300);
    expect(count(h, (e) => e.type === "output")).toBe(1);
    expect(h.plane.unparsed).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
