import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TmuxRunner } from "@internal/pane-runtime";
import {
  type ControlKeyPair,
  generateControlKeys,
  HARNESS_BINARY_PLACEHOLDER,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeCommandBody,
  type NodeEvent,
  type NodeRuntimeReport,
  parseNodeEvent,
  signCommand,
} from "@internal/subshell-protocol";
import { run as runCli } from "../cli.js";
import { TAIL_POLL_MS } from "../commands/tail.js";
import { type NodeConfig, saveConfig } from "../config.js";
import {
  type DaemonDeps,
  probeOnline,
  runDaemon,
  updateRequiredMessage,
  type WsConstructor,
  type WsLike,
  wsUrlFor,
} from "../daemon.js";
import { type DaemonLock, lockPath } from "../lock.js";
import { maintenancePath, writeMaintenance } from "../maintenance.js";
import { sweepIsScheduled } from "../retention-settings.js";
import { SubshellMetaStore } from "../subshell-meta.js";
import { newHome } from "../test-preload.js";
import { NODE_VERSION } from "../version.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * The daemon under a fake control plane. The plane is a real `Bun.serve` ws
 * endpoint: the daemon dials it with its bearer header (proving the client
 * options cast works at runtime), and EVERY outbound frame the agent sends is
 * parsed with the real `parseNodeEvent` — that is the wire contract test
 * (the backend's node-ws-handler parses inbound frames the same way).
 */

const NODE_ID = "test-node-1";
const NODE_KEY = "subshell_node_key_never_printed";

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
  config: NodeConfig;
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

/** Every per-harness dataDir created below, removed together at file end. */
const daemonDirs: string[] = [];
afterAll(() => {
  for (const dir of daemonDirs) rmSync(dir, { recursive: true, force: true });
});

async function startDaemon(
  overrides: Partial<
    Pick<
      DaemonDeps,
      | "heartbeatMs"
      | "inventoryMs"
      | "rand"
      | "tmux"
      | "meta"
      | "WebSocketImpl"
      | "runtime"
      | "retentionMs"
      | "retentionPass"
    >
  > & { config?: Partial<NodeConfig> } = {},
): Promise<Harness> {
  const { config: configPatch, ...daemonOverrides } = overrides;
  const [keys, hostileKeys] = await Promise.all([keysReady, hostileKeysReady]);
  const plane = startPlane();
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-daemon-"));
  daemonDirs.push(dataDir);
  const config: NodeConfig = {
    serverUrl: `http://localhost:${plane.server.port}`,
    nodeId: NODE_ID,
    nodeKey: NODE_KEY,
    controlPublicKey: JSON.stringify(keys.publicJwk),
    // Fresh per harness: the daemon holds no plugin concept at all
    // (inversion §6), but a shared /tmp path could still carry pre-inversion
    // residue into anything a future daemon reads — a fresh dir keeps every
    // run deterministic. Removed in the file's afterAll.
    dataDir,
    name: "test-node",
    ...configPatch,
  };
  const exits: number[] = [];
  const h: Harness = { plane, config, keys, hostileKeys, exits, stopped: Promise.resolve() };
  const promise = runDaemon(config, {
    runtime: null, // no `service status` spawn in tests; the report is Task 11's own suite
    rand: () => 0, // zero-jitter → instant reconnects (tests must not wait out backoff)
    heartbeatMs: 3_600_000, // interval effectively off; the heartbeat test overrides
    inventoryMs: 3_600_000, // periodic push effectively off; the P3-T8c tests override (the inventory COMMAND tests count frames against the connect-push baseline)
    exit: (code: number): never => {
      exits.push(code);
      throw new DaemonStopped(code);
    },
    ...daemonOverrides,
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

/**
 * Poll a plain condition, for the cases where the thing being waited on is a
 * side effect rather than a plane event.
 */
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
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

/**
 * The dial URL is built by string replacement on the scheme, so its CASE is
 * load-bearing. `normalizeServer` lower-cases before persisting, but a
 * hand-edited `config.json` can still carry `HTTP://` — and the
 * case-sensitive form produced `HTTP://host/ws/node`, which is not a
 * WebSocket URL at all, with nothing naming the reason.
 */
test("wsUrlFor tolerates a mixed-case scheme in a hand-edited config", () => {
  expect(wsUrlFor("HTTP://box.local:3080")).toBe("ws://box.local:3080/ws/node");
  expect(wsUrlFor("HTTPS://subshell.example")).toBe("wss://subshell.example/ws/node");
  expect(wsUrlFor("Http://box.local:3080")).toBe("ws://box.local:3080/ws/node");
});

test("wsUrlFor derives wss/ws + /ws/node from the server URL", () => {
  expect(wsUrlFor("https://subshell.example")).toBe("wss://subshell.example/ws/node");
  expect(wsUrlFor("https://subshell.example:5173")).toBe("wss://subshell.example:5173/ws/node");
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
      { WebSocketImpl: RecordingWs, runtime: null },
    ),
  ).rejects.toThrow(/cannot open wss:\/\/pin\.example\/ws\/node/);
  expect(dialed).toEqual(["wss://pin.example/ws/node"]);

  // Absent persisted URL (config from before 17c) ⇒ the derived path, verbatim.
  dialed.length = 0;
  await expect(
    runDaemon({ ...base, serverUrl: "https://control.example" }, { WebSocketImpl: RecordingWs, runtime: null }),
  ).rejects.toThrow(/cannot open wss:\/\/control\.example\/ws\/node/);
  expect(dialed).toEqual(["wss://control.example/ws/node"]);
});

test("sends a ready frame the real parseNodeEvent accepts, with protocol identity", async () => {
  const h = await startDaemon();
  const ready = await waitForReady(h);
  expect(ready).toMatchObject({
    type: "ready",
    agentVersion: NODE_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    arch: process.arch,
    hostname: hostname(),
    dataDir: h.config.dataDir,
    // Phase 2 (Task 4): the capability set advertises the phase-2 command
    // surface; Task 13 shipped the `mcp` subcommand, so `mcp` is advertised
    // alongside `uploads` (this list is what the backend's capability gate reads).
    capabilities: ["uploads", "mcp"],
    // Spec 2026-09-10 §5: the resume-path home. The env VALUES a resume may
    // need answer on the plane's `detect` round trip, not here — a node holds
    // no manifests to know the names (inversion §6).
    homeDir: homedir(),
  });
  const os = (ready as Extract<NodeEvent, { type: "ready" }>).os;
  expect(["linux", "darwin", "unknown"]).toContain(os);
  expect(ready as Record<string, unknown>).not.toHaveProperty("env");
  expect(ready as Record<string, unknown>).not.toHaveProperty("executablePath");
  expect(h.plane.unparsed).toEqual([]); // every frame so far satisfies the backend's parser
});

test("ready's selfInvoke is the branched self-invocation PREFIX, not a bare execPath", async () => {
  // The Critical chain (final review R14a): the plane composes the pane's MCP
  // registration and its harness hooks from this field, and under an
  // interpreter run `process.execPath` is `bun` — `bun mcp` is not a command,
  // so the bare path poisoned every pane a dev-run agent launched.
  // `bun test` IS an interpreter run, so this frame is exactly the case: the
  // command is the interpreter and the args are the entry script alone.
  const h = await startDaemon();
  const ready = (await waitForReady(h)) as Extract<NodeEvent, { type: "ready" }>;
  expect(ready.selfInvoke).toBeDefined();
  expect(ready.selfInvoke?.command).toBe(process.execPath);
  // NO subcommand: the plane appends `mcp` or `report` to this prefix, which
  // is what keeps one reported fact serving both.
  expect(ready.selfInvoke?.args.length).toBe(1); // [<entry script>]
  // ABSOLUTE, the pane-config spawn cwd rule from `selfInvokePrefix`: the entry
  // is resolved, never shipped as the relative argv[1] it may arrive as.
  expect(ready.selfInvoke?.args[0]).toBe(resolve(process.argv[1] ?? ""));
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
test("launch (valid wire, hostile subshell id) → result ok:false invalid subshell id", async () => {
  const h = await startDaemon();
  const launch: NodeCommandBody = {
    type: "launch",
    subshellId: "s1",
    socket: "subshell-s1",
    cwd: "/tmp",
    harnessId: "claude-code",
    preset: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    subshellEnv: {},
    subshellName: "s1",
    // Required on the frame since protocol 3; the id gate fires first, so
    // neither is ever read — the frame just has to PARSE to reach it.
    argv: [HARNESS_BINARY_PLACEHOLDER],
    resolve: { binaryName: "claude" },
  };
  const jti = await signAndSend(h, launch, { jti: "launch-1", seq: 1 });
  const result = await waitFor<Extract<NodeEvent, { type: "result" }>>(h, (e) => e.type === "result", "result");
  expect(result.ref).toBe(jti);
  expect(result).toMatchObject({ ok: false, error: "invalid subshell id" });
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
  // Post-inversion (spec §6): the event carries no harness scan — the shape
  // the v3 validator requires with the honest empty content (`harnesses`
  // stays a required field; it was the `plugins` field that left the wire at
  // protocol 3). The server-side guard that treats empty as "nothing to
  // apply" is pinned by the server's node-ws-handler tests.
  expect(inv.harnesses).toEqual([]);
  expect("plugins" in inv).toBe(false);
  expect(typeof inv.ts).toBe("string");
  expect(result).toMatchObject({ ref: jti, ok: true });
});

// `detect` rides the same daemon path (verify → dispatch → result) as every
// other command; the executor's behavior lives in commands-basics.test.ts.
// This is the command-census entry: the type must be wired, end to end.
test("detect command: signed frame through the socket → result ok with the parsed rows payload", async () => {
  const h = await startDaemon();
  await waitFor(h, (e) => e.type === "inventory", "connect inventory push");
  const jti = await signAndSend(h, { type: "detect", specs: [], envNames: [] }, { jti: "detect-1", seq: 1 });
  const result = await waitFor<Extract<NodeEvent, { type: "result" }>>(
    h,
    (e) => e.type === "result" && e.ref === jti,
    "detect result",
  );
  expect(result).toMatchObject({ ok: true });
  // The `{}` half of the result is REQUIRED: an empty envNames answers an
  // empty env, never an omitted field (§5 as amended).
  expect((result as { data?: unknown }).data).toEqual({ results: [], env: {} });
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
  const config: NodeConfig = {
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
    runtime: null,
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
  const { lines, restore } = captureLogs();
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
      runtime: null,
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
    restore();
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
    agentVersion: NODE_VERSION,
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
  // …and the remedy it names is the one that SURVIVES this terminal closing
  // (spec 2026-09-15 §4.5). It used to offer `subshell run` alone, which is
  // the foreground dead end; `run` stays named, after the service verbs.
  expect(off.out).toInclude("subshell service start");
  expect(off.out).toInclude("subshell service install");
  // Backticked, because a bare "subshell run" also matches the line's own
  // "no local subshell running" and would compare the wrong position.
  expect(off.out.indexOf("service start")).toBeLessThan(off.out.indexOf("`subshell run`"));
  expect(off.out).toInclude("a probe KICKS a remote agent"); // the warning is NOT dropped
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

/**
 * The shapes a socket layer can hand a `message` listener: text, and the two
 * binary spellings (`admitFrame` normalizes both — Bun's client delivers a
 * Buffer, the WebAPI spelling is an ArrayBuffer).
 */
type DeliveredFrame = string | Uint8Array | ArrayBuffer;

/**
 * Wraps the real WebSocket and keeps each socket's `message` listeners, so a
 * test can hand the daemon several frames in ONE event-loop turn.
 *
 * Sending them from the plane does not do that: they cross a real socket and
 * arrive as separate turns, which is exactly the case that already worked.
 * Frames are text OR bytes (task 6: the binary shapes a real socket delivers,
 * so the byte guards see what production sees).
 * @param pumps - filled with one entry per socket the daemon opens
 */
function wrapRealWsWithPump(pumps: Array<{ deliverBurst: (frames: DeliveredFrame[]) => void }>): WsConstructor {
  const Real = globalThis.WebSocket as unknown as new (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => WsLike;
  class Pumped {
    private readonly inner: WsLike;
    private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.inner = new Real(url, opts);
      pumps.push({
        deliverBurst: (frames: DeliveredFrame[]): void => {
          for (const frame of frames) {
            for (const listener of this.messageListeners) listener({ data: frame });
          }
        },
      });
    }
    get readyState(): number {
      return this.inner.readyState;
    }
    send(data: string | Uint8Array): void {
      this.inner.send(data);
    }
    close(code?: number, reason?: string): void {
      this.inner.close(code, reason);
    }
    addEventListener(type: string, listener: (event?: unknown) => void): void {
      if (type === "message") this.messageListeners.push(listener as (event: { data: unknown }) => void);
      const add = this.inner.addEventListener as unknown as (t: string, l: unknown) => void;
      add.call(this.inner, type, listener);
    }
  }
  return Pumped as unknown as WsConstructor;
}

test("a burst of frames in one turn is verified in ARRIVAL order, not signature-check order", async () => {
  // `verifyCommand` awaits an ES256 `crypto.subtle.verify` BEFORE the seq gate
  // (`node-signing.ts`), and the gate refuses any seq <= the last accepted. So
  // with a frame handler that starts each message's verify immediately, three
  // frames arriving in one event-loop turn reach the gate in whatever order
  // the crypto finishes — and the moment seq 3 is accepted before seq 2, the
  // daemon calls seq 2 a REGRESSION and closes the connection (spec §4).
  //
  // That is a paste, or fast typing, on a node: the burst takes down every
  // subshell on that machine until the reconnect. The per-pane input chain in
  // `TmuxRunner` cannot help — the damage is done before anything is enqueued.
  //
  // This is very likely also what the CI flake noted on the serialization test
  // below was (2026-09-07: `order` held only "input:start", the terminate
  // never reaching its handler at all).
  const sent: string[] = [];
  const fakeTmux = {
    sendInput: async (_socket: string, _id: string, data: string) => {
      sent.push(data);
    },
  } as unknown as TmuxRunner;
  const pumps: Array<{ deliverBurst: (frames: DeliveredFrame[]) => void }> = [];
  const h = await startDaemon({
    tmux: fakeTmux,
    meta: { get: async () => undefined, list: async () => [] } as unknown as SubshellMetaStore,
    WebSocketImpl: wrapRealWsWithPump(pumps),
  });
  // FIVE, not three: measured on this machine, three concurrent
  // `verifyCommand` calls land out of order in 19 of 20 rounds, so three would
  // leave a ~5% chance of passing on the broken code. Five makes that
  // vanishing while still being a plausible burst (it is a short paste).
  const keystrokes = ["a", "b", "c", "d", "e"];
  // Signed UP FRONT so the deliveries are synchronous — one event-loop turn,
  // which is the condition being tested.
  const frames = await Promise.all(
    keystrokes.map((data, i) => signEnvelope(h, { type: "input", subshellId: HEX_A, data }, `burst-${i + 1}`, i + 1)),
  );
  const pump = pumps.at(-1);
  if (!pump) throw new Error("no socket was opened");
  const closesBefore = h.plane.closes;
  pump.deliverBurst(frames);

  await waitFor(h, (e) => e.type === "result" && e.ref === `burst-${keystrokes.length}`, "the last input's result");
  // Every one accepted: no verify error, and above all no seq regression.
  expect(eventsAs(h, "error").map((e) => e.message)).toEqual([]);
  expect(h.plane.closes).toBe(closesBefore);
  // Arrival order end to end — the results and the pane effects alike.
  expect(eventsAs(h, "result").map((e) => e.ref)).toEqual(keystrokes.map((_, i) => `burst-${i + 1}`));
  expect(sent).toEqual(keystrokes);
  expect(h.plane.unparsed).toEqual([]);
});

test("an oversize frame is dropped on ARRIVAL, not queued behind the chain", async () => {
  // The two byte guards are synchronous and cost nothing, so they run before
  // a frame joins the serialization chain. Behind it, a burst of oversize
  // frames would be RETAINED in the queue before being rejected — the daemon
  // holding megabytes of noise it has already decided to drop.
  //
  // Asserted with no await at all, which is the whole point: `deliverBurst`
  // returns once the listener has run for both frames, and by then the
  // oversize one must ALREADY be logged even though the input ahead of it is
  // still mid-verify. Chained, nothing would be logged yet.
  const pumps: Array<{ deliverBurst: (frames: DeliveredFrame[]) => void }> = [];
  const h = await startDaemon({
    tmux: { sendInput: async () => {} } as unknown as TmuxRunner,
    meta: { get: async () => undefined, list: async () => [] } as unknown as SubshellMetaStore,
    WebSocketImpl: wrapRealWsWithPump(pumps),
  });
  const input = await signEnvelope(h, { type: "input", subshellId: HEX_A, data: "x" }, "admit-1", 1);
  const oversize = JSON.stringify({ jws: "x".repeat(NODE_MAX_FRAME_BYTES + 10_000) });
  const pump = pumps.at(-1);
  if (!pump) throw new Error("no socket was opened");

  const logs = captureLogs();
  try {
    pump.deliverBurst([input, oversize]);
    expect(logs.lines.some((l) => l.includes("oversize frame ignored"))).toBe(true);
  } finally {
    logs.restore();
  }
  // …and the connection is unharmed: the input ahead of it still lands.
  await waitFor(h, (e) => e.type === "result" && e.ref === "admit-1", "the input's result");
  expect(h.plane.closes).toBe(0);
});

/* ------------------------------------------------------------------ */
/* Task 6: binary frames survive the wire (plumbing, no session yet)   */
/* ------------------------------------------------------------------ */

test("binary frames arrive as bytes, are ignored while no link exists, and NEVER reach the text path", async () => {
  // `admitFrame` returns `{ bytes }` for every binary shape (the pump hands
  // frames in as the socket layer would: a Buffer, a plain Uint8Array, and an
  // ArrayBuffer — Bun's client delivers whichever its `binaryType` names).
  // The listener drops them with the SAME ignore-don't-close posture the old
  // blanket "ignored non-text frame" had, because there is no session to open
  // them until task 9. The assertion that gives this teeth: bytes must not
  // fall into `onFrame`, where a failed JSON.parse answers the plane with a
  // `verify: malformed` error event.
  const pumps: Array<{ deliverBurst: (frames: DeliveredFrame[]) => void }> = [];
  const h = await startDaemon({
    tmux: { sendInput: async () => {} } as unknown as TmuxRunner,
    meta: { get: async () => undefined, list: async () => [] } as unknown as SubshellMetaStore,
    WebSocketImpl: wrapRealWsWithPump(pumps),
  });
  const input = await signEnvelope(h, { type: "input", subshellId: HEX_A, data: "z" }, "bytes-1", 1);
  const pump = pumps.at(-1);
  if (!pump) throw new Error("no socket was opened");

  const logs = captureLogs();
  try {
    pump.deliverBurst([Buffer.alloc(5, 7), new Uint8Array([1, 2, 3]), new ArrayBuffer(4), input]);
    expect(logs.lines.filter((l) => l.includes("ignored binary frame")).length).toBe(3);
  } finally {
    logs.restore();
  }
  // No answered error frames — nothing binary was parsed as text — and the
  // input behind them still processes normally.
  await waitFor(h, (e) => e.type === "result" && e.ref === "bytes-1", "the input's result");
  expect(eventsAs(h, "error")).toEqual([]);
  expect(h.plane.closes).toBe(0);
});

test("an oversize BINARY frame is refused on ARRIVAL exactly like an oversize text one", async () => {
  // Same cap, same guards, same shape: measured by `bytes.length`, ignored,
  // never queued behind the chain — the R2 ruling's agent-side twin.
  const pumps: Array<{ deliverBurst: (frames: DeliveredFrame[]) => void }> = [];
  const h = await startDaemon({
    tmux: { sendInput: async () => {} } as unknown as TmuxRunner,
    meta: { get: async () => undefined, list: async () => [] } as unknown as SubshellMetaStore,
    WebSocketImpl: wrapRealWsWithPump(pumps),
  });
  const input = await signEnvelope(h, { type: "input", subshellId: HEX_A, data: "x" }, "bigbytes-1", 1);
  const oversize = new Uint8Array(NODE_MAX_FRAME_BYTES + 10_000);
  const pump = pumps.at(-1);
  if (!pump) throw new Error("no socket was opened");

  const logs = captureLogs();
  try {
    pump.deliverBurst([input, oversize]);
    // Asserted with no await: the drop happened on ARRIVAL, not behind the
    // chain the input now occupies mid-verify.
    expect(logs.lines.some((l) => l.includes("oversize frame ignored"))).toBe(true);
  } finally {
    logs.restore();
  }
  await waitFor(h, (e) => e.type === "result" && e.ref === "bigbytes-1", "the input's result");
  expect(h.plane.closes).toBe(0);
});

test("WsLike carries binary sends (the seam task 9's sealed outbound frames need)", () => {
  // `implements WsLike` makes the fake a COMPILE-TIME check of the widened
  // `send(data: string | Uint8Array)` — narrowing the interface again fails
  // right here, in the one suite that will soon drive a real session. The
  // runtime assertion proves the recording wrapper keeps bytes intact.
  class Recording implements WsLike {
    readonly readyState = 1;
    readonly sends: Array<string | Uint8Array> = [];
    send(data: string | Uint8Array): void {
      this.sends.push(data);
    }
    close(): void {}
    addEventListener(): void {}
  }
  const sock: WsLike = new Recording();
  sock.send(JSON.stringify({ type: "heartbeat" }));
  sock.send(new Uint8Array([9, 8, 7]));
  expect(sock instanceof Recording).toBe(true);
  const recorded = (sock as Recording).sends;
  expect(typeof recorded[0]).toBe("string");
  expect(recorded[1]).toEqual(new Uint8Array([9, 8, 7]));
});

test("commands run SERIALLY in arrival order (spec §3.4): the second starts only after the first's promise resolves", async () => {
  // The first command (terminate) is made slow INSIDE its await (the meta
  // lookup); the second (resize) is instant. With the old per-message
  // `void onFrame(...)` they interleave (the second lands while terminate is
  // still parked), so the exact order array is the serialization proof.
  // The second command is a RESIZE, not an input: spec 2026-09-21 Wave A moved
  // input onto its own chain, so an input would now legitimately interleave
  // here and the assertion would describe the fast path, not the main chain.
  const order: string[] = [];
  const fakeTmux = {
    run: () => {
      order.push("terminate:end"); // the kill-session call — the first command's effect
      return { stdout: "", stderr: "" };
    },
    resizeWindow: () => {
      order.push("resize:start"); // the second command's start
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
    // The connect-time subshells_report scan needs it too — without `list` every
    // connect logs "subshells_report failed" noise around this test.
    list: async () => [],
  } as unknown as SubshellMetaStore;
  const h = await startDaemon({ tmux: fakeTmux, meta: slowMeta });
  const jtiT = await signAndSend(h, { type: "terminate", subshellId: HEX_A }, { jti: "ser-t", seq: 1 });
  // Send the second only once the first is PROVABLY executing — it is parked
  // inside `slowMeta.get`'s 60 ms sleep at this point, so the second still
  // arrives mid-flight and the interleaving this test exists to catch is
  // unchanged.
  //
  // Firing both back-to-back made the test depend on them landing on the same
  // socket in the same order, which is not something it means to assert: this
  // case failed twice on CI (2026-09-07) with `order` holding ONLY the second
  // command's start, i.e. the terminate never reached its handler at all while
  // the second did. Not reproducible locally (six full-suite runs under CPU
  // load stayed green), so this removes the dependency rather than claiming a
  // diagnosis, and if the terminate is still lost the failure is now a named
  // timeout here instead of a mystifying order mismatch below.
  await waitUntil(() => order.includes("terminate:start"), "the terminate command to start");
  const jtiR = await signAndSend(
    h,
    { type: "resize", subshellId: HEX_B, cols: 80, rows: 24 },
    { jti: "ser-r", seq: 2 },
  );
  await waitFor(h, (e) => e.type === "result" && e.ref === jtiR, "resize result");
  // The second's start FOLLOWS the first's end — strict serial, arrival order.
  expect(order).toEqual(["terminate:start", "terminate:awaited", "terminate:end", "resize:start"]);
  // …and the result frames carry the same order.
  const refs = eventsAs(h, "result").map((e) => e.ref);
  expect(refs.indexOf(jtiT)).toBeLessThan(refs.indexOf(jtiR));
  expect(h.plane.unparsed).toEqual([]);
});

test("input does not queue behind the main chain: a slow capture does not delay the next input", async () => {
  // Spec 2026-09-21 Wave A: input joins its own chain. The capture is parked
  // inside its 60 ms tmux await when two inputs arrive; their results must
  // beat the capture's, while the inputs themselves keep THEIR arrival order.
  const order: string[] = [];
  const fakeTmux = {
    capturePane: async () => {
      order.push("capture:start");
      await sleep(60);
      order.push("capture:end");
      return "screen";
    },
    sendInput: async (_socket: string, _id: string, data: string) => {
      order.push(`input:${data}`);
    },
  } as unknown as TmuxRunner;
  const h = await startDaemon({
    tmux: fakeTmux,
    meta: { get: async () => undefined, list: async () => [] } as unknown as SubshellMetaStore,
  });
  const jtiC = await signAndSend(h, { type: "capture", subshellId: HEX_A, lines: 5 }, { jti: "fast-c", seq: 1 });
  // Only send the inputs once the capture is PROVABLY executing, so the race
  // is the real one (a keystroke arriving mid-capture), not a scheduling gap.
  await waitUntil(() => order.includes("capture:start"), "the capture to start");
  const jti1 = await signAndSend(h, { type: "input", subshellId: HEX_A, data: "a" }, { jti: "fast-1", seq: 2 });
  const jti2 = await signAndSend(h, { type: "input", subshellId: HEX_A, data: "b" }, { jti: "fast-2", seq: 3 });
  await waitFor(h, (e) => e.type === "result" && e.ref === jti2, "the second input's result");
  // The inputs finished while the capture was still parked in its await.
  expect(order).toEqual(["capture:start", "input:a", "input:b"]);
  await waitFor(h, (e) => e.type === "result" && e.ref === jtiC, "the capture's result");
  expect(order[order.length - 1]).toBe("capture:end");
  // …and the result frames carry the same order.
  const refs = eventsAs(h, "result").map((e) => e.ref);
  expect(refs.indexOf(jti1)).toBeLessThan(refs.indexOf(jti2));
  expect(refs.indexOf(jti2)).toBeLessThan(refs.indexOf(jtiC));
  expect(h.plane.unparsed).toEqual([]);
});

test("input keeps ITS arrival order: a slow first input delays the second (concurrency is with the main chain only)", async () => {
  // The fast path is order-preserving WITHIN the input chain. The first input
  // is made slow INSIDE its await; the second arrives mid-flight and must
  // start only after the first's promise resolved.
  const order: string[] = [];
  let first = true;
  const fakeTmux = {
    sendInput: async (_socket: string, _id: string, data: string) => {
      order.push(`input:${data}:start`);
      if (first) {
        first = false;
        await sleep(60);
      }
      order.push(`input:${data}:end`);
    },
  } as unknown as TmuxRunner;
  const h = await startDaemon({
    tmux: fakeTmux,
    meta: { get: async () => undefined, list: async () => [] } as unknown as SubshellMetaStore,
  });
  const jti1 = await signAndSend(h, { type: "input", subshellId: HEX_A, data: "a" }, { jti: "ord-1", seq: 1 });
  await waitUntil(() => order.includes("input:a:start"), "the first input to start");
  const jti2 = await signAndSend(h, { type: "input", subshellId: HEX_A, data: "b" }, { jti: "ord-2", seq: 2 });
  await waitFor(h, (e) => e.type === "result" && e.ref === jti2, "the second input's result");
  expect(order).toEqual(["input:a:start", "input:a:end", "input:b:start", "input:b:end"]);
  const refs = eventsAs(h, "result").map((e) => e.ref);
  expect(refs.indexOf(jti1)).toBeLessThan(refs.indexOf(jti2));
  expect(h.plane.unparsed).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Phase 2 Task 4: connect-time subshells_report (spec §3.3)            */
/* ------------------------------------------------------------------ */

test("subshells_report lands AFTER ready: one row per recorded meta, re-projection on connect", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-daemon-report-"));
  const store = new SubshellMetaStore(dataDir); // simulates panes that survived an agent restart
  await store.record({
    subshellId: HEX_A,
    cwd: dataDir,
    socket: "rep-sock",
    harnessId: "pi",
    name: "a",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  await store.record({
    subshellId: HEX_B,
    cwd: dataDir,
    socket: "rep-sock",
    harnessId: "pi",
    name: "b",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const fakeTmux = {
    hasSubshell: (_socket: string, id: string) => id === HEX_A,
    paneExitCode: () => 5,
  } as unknown as TmuxRunner;
  try {
    const h = await startDaemon({ tmux: fakeTmux, meta: store });
    const report = await waitFor<Extract<NodeEvent, { type: "subshells_report" }>>(
      h,
      (e) => e.type === "subshells_report",
      "subshells_report frame",
    );
    const types = eventTypes(h);
    expect(types.indexOf("subshells_report")).toBeGreaterThan(types.indexOf("ready")); // after ready (spec §3.3)
    expect(report.subshells).toEqual([
      { subshellId: HEX_A, alive: true, exitCode: null },
      { subshellId: HEX_B, alive: false, exitCode: 5 },
    ]);
    expect(h.plane.unparsed).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* P3-T8b: connect-time initial inventory push (spec §7)                */
/* ------------------------------------------------------------------ */

test("connect pushes an inventory snapshot AFTER subshells_report: a fresh node launches without a manual recheck", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-daemon-invpush-"));
  const store = new SubshellMetaStore(dataDir);
  await store.record({
    subshellId: HEX_A,
    cwd: dataDir,
    socket: "inv-sock",
    harnessId: "pi",
    name: "a",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const fakeTmux = {
    hasSubshell: () => true,
    paneExitCode: () => null,
  } as unknown as TmuxRunner;
  try {
    const h = await startDaemon({ tmux: fakeTmux, meta: store });
    const inv = await waitFor<Extract<NodeEvent, { type: "inventory" }>>(
      h,
      (e) => e.type === "inventory",
      "connect inventory frame",
    );
    // The beat pinned (P3-T8b): ready → subshells_report → inventory. The backend
    // reconcile applies the census's exits BEFORE the snapshot lands, so the
    // inventory must never overtake the report.
    const types = eventTypes(h);
    expect(types.indexOf("subshells_report")).toBeGreaterThan(types.indexOf("ready"));
    expect(types.indexOf("inventory")).toBeGreaterThan(types.indexOf("subshells_report"));
    expect(inv.harnesses).toEqual([]); // same builder the `inventory` command answers with
    expect(typeof inv.ts).toBe("string");
    expect(h.plane.unparsed).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a throwing subshells_report scan is catch-logged, never fatal to the connection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-daemon-report-fail-"));
  const store = new SubshellMetaStore(dataDir);
  await store.record({
    subshellId: HEX_A,
    cwd: dataDir,
    socket: "x",
    harnessId: "pi",
    name: "a",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const fakeTmux = {
    hasSubshell: () => {
      throw new Error("tmux exploded");
    },
  } as unknown as TmuxRunner;
  try {
    const h = await startDaemon({ tmux: fakeTmux, meta: store });
    const jti = await signAndSend(h, { type: "ping" }, { jti: "after-report-fail", seq: 1 });
    await waitFor(h, (e) => e.type === "result" && e.ref === jti, "ping result after a failed report scan");
    expect(count(h, (e) => e.type === "subshells_report")).toBe(0); // the scan failed, so no frame — and no close
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
function wrapRealWs(
  sockets: Array<{ sends: Array<string | Uint8Array> }>,
  state: { throwOnSend: boolean },
): WsConstructor {
  const Real = globalThis.WebSocket as unknown as new (
    url: string,
    opts?: { headers?: Record<string, string> },
  ) => WsLike;
  class Wrapped {
    readonly sends: Array<string | Uint8Array> = [];
    private readonly inner: WsLike;
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.inner = new Real(url, opts);
      sockets.push(this);
    }
    get readyState(): number {
      return this.inner.readyState;
    }
    send(data: string | Uint8Array): void {
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

/**
 * How many of a wrapped socket's recorded TEXT sends were `inventory` events.
 * (Binary sends exist on the socket from task 9 on — they are ciphertext,
 * never an inventory event, so they parse-fail out of this count by shape.)
 */
function inventorySendCount(sock: { sends: Array<string | Uint8Array> } | undefined): number {
  if (!sock) return 0;
  return sock.sends.filter((s) => {
    if (typeof s !== "string") return false;
    try {
      return (JSON.parse(s) as { type?: string }).type === "inventory";
    } catch {
      return false;
    }
  }).length;
}

test("periodic inventory: ticks push on the interval; close clears the loop; the reconnect arms exactly one", async () => {
  const sockets: Array<{ sends: Array<string | Uint8Array> }> = [];
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
  const sockets: Array<{ sends: Array<string | Uint8Array> }> = [];
  const h = await startDaemon({ inventoryMs: 40, WebSocketImpl: wrapRealWs(sockets, state) });
  await waitFor(h, () => count(h, (e) => e.type === "inventory") >= 2, "connect push + first tick");
  const { lines, restore } = captureLogs();
  state.throwOnSend = true;
  await sleep(160); // several ticks whose sends throw — every one must be swallowed + logged
  const before = count(h, (e) => e.type === "inventory");
  state.throwOnSend = false;
  await waitFor(h, () => count(h, (e) => e.type === "inventory") > before, "a tick after the send recovered");
  restore();
  expect(h.plane.closes).toBe(0); // a failed push costs a log line, never the connection
  expect(lines.some((l) => l.includes("send inventory failed"))).toBe(true);
});

test("outbound guard: an oversize result is suppressed + logged, never sent; the link survives", async () => {
  const fakeTmux = {
    capturePane: () => "x".repeat(NODE_MAX_FRAME_BYTES), // result frame exceeds the 1 MiB cap
  } as unknown as TmuxRunner;
  const h = await startDaemon({ tmux: fakeTmux });
  const { lines, restore } = captureLogs();
  const jti = await signAndSend(h, { type: "capture", subshellId: HEX_A }, { jti: "big-1", seq: 1 });
  await sleep(100);
  restore();
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
  const dataDir = mkdtempSync(join(tmpdir(), "subshell-daemon-tail-"));
  mkdirSync(join(dataDir, "subshells"), { recursive: true });
  const store = new SubshellMetaStore(dataDir);
  const file = store.logPath(HEX_A);
  writeFileSync(file, "abc");
  try {
    const h = await startDaemon({ meta: store });
    await signAndSend(
      h,
      { type: "tail_start", subshellId: HEX_A, subId: "d-1", fromByte: 0 },
      { jti: "tail-1", seq: 1 },
    );
    const out = await waitFor<Extract<NodeEvent, { type: "output" }>>(h, (e) => e.type === "output", "tail output");
    expect(out).toMatchObject({ subId: "d-1", subshellId: HEX_A, fromByte: 0, toByte: 3 });

    // Non-terminal close → finish() drains ctx.tails (stopAllTails) → reconnect.
    closeAllSockets(h.plane, 1001, "server restart");
    await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
    appendFileSync(file, "de");
    // Outlast the backstop window: a surviving pump WOULD have delivered —
    // tails must never push into a dead ws, and the daemon must not auto-resume
    // subscriptions (the control plane re-`tail_start`s with its own cursors).
    await sleep(TAIL_POLL_MS + 300);
    expect(count(h, (e) => e.type === "output")).toBe(1);
    expect(h.plane.unparsed).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("4406 refusal message", () => {
  // The floor exists so an operator can ACT on the refusal, and this line is
  // the only place they read it. It used to be hardcoded to "rejected protocol
  // vN", which named the wrong gate for a version-floor refusal and told them
  // neither the required nor the found version.
  test("relays the server's reason verbatim", () => {
    expect(updateRequiredMessage("subshell 0.3.0 or newer required (this agent is 0.2.1)")).toContain(
      "subshell 0.3.0 or newer required (this agent is 0.2.1)",
    );
    expect(updateRequiredMessage("protocol v4 required (this agent speaks v3)")).toContain("this agent speaks v3");
  });

  test("still says something actionable when the server sent no reason", () => {
    const line = updateRequiredMessage(undefined);
    expect(line).toContain("4406");
    expect(line).toContain("newer subshell");
    expect(line).not.toContain("undefined");
    expect(updateRequiredMessage("")).toBe(line);
  });
});

describe("restart command (spec 2026-09-12 § 6.3)", () => {
  const supervised: NodeRuntimeReport = {
    startedAt: "2026-09-12T00:00:00.000Z",
    supervised: true,
    service: {
      manager: "systemd",
      installed: true,
      definitionPath: "/u/.config/systemd/user/subshell.service",
      state: "running",
      pid: process.pid,
      enabled: true,
      linger: true,
      paneSafety: "keeps",
    },
    configPath: "/c",
    agentLogPath: "/tmp/agent.log",
    logPath: null,
    logHint: "journalctl --user -u subshell.service -f",
    tmuxPath: "/usr/bin/tmux",
    binaryPath: "/b",
    logging: { debug: false, source: "default" as const },
  };

  test("carries the runtime report in ready, and the real parseNodeEvent keeps it", async () => {
    const h = await startDaemon({ runtime: supervised });
    const ready = await waitForReady(h);
    expect(ready).toMatchObject({ type: "ready", runtime: supervised });
    expect(h.plane.unparsed).toEqual([]);
  });

  // The ORDER is the contract: the daemon is the only sender of `result`, so
  // an executor that exited itself would leave the plane waiting out a
  // timeout instead of seeing a success.
  test("answers ok FIRST, then exits 0 for the service manager to respawn", async () => {
    const h = await startDaemon({ runtime: supervised });
    await waitForReady(h);
    const jti = await signAndSend(h, { type: "service", verb: "restart" });
    const res = await waitFor(h, (e) => e.type === "result" && e.ref === jti, "restart result");
    expect(res).toMatchObject({ ok: true });
    // The exit follows the frame, and it is a CLEAN 0 — a non-zero exit would
    // read as a crash in the journal the operator checks after a restart.
    await Promise.race([h.stopped, sleep(3000)]);
    expect(h.exits).toEqual([0]);
    expect(h.plane.unparsed).toEqual([]);
  });

  test("an unsupervised agent refuses and keeps running", async () => {
    const h = await startDaemon({ runtime: { ...supervised, supervised: false } });
    await waitForReady(h);
    const jti = await signAndSend(h, { type: "service", verb: "restart" });
    const res = await waitFor(h, (e) => e.type === "result" && e.ref === jti, "restart refusal");
    expect(res).toMatchObject({ ok: false, error: "not supervised" });
    await sleep(400); // past RESTART_EXIT_DELAY_MS: nothing may have exited
    expect(h.exits).toEqual([]);
  });
});

describe("maintenance (spec 2026-09-14 §4.3)", () => {
  const STAMP = "2026-09-14T10:00:00.000Z";

  test("ready OMITS the field when this machine has no mirror file", async () => {
    // Absent is a distinct answer from `{on:false}` on the wire: it tells the
    // plane the node has nothing to reconcile against, so the plane's own row
    // wins rather than tying with a stamp the node never wrote.
    const h = await startDaemon();
    const ready = await waitForReady(h);
    expect(ready as Record<string, unknown>).not.toHaveProperty("maintenance");
    expect(h.plane.unparsed).toEqual([]);
  });

  test("ready carries the mirror's state on the connect that follows a write", async () => {
    const h = await startDaemon();
    await waitForReady(h);
    writeMaintenance(h.config.dataDir, { on: true, changedAt: STAMP });
    // A non-terminal close reconnects (rand 0 → immediate), which is the only
    // moment `ready` is rebuilt.
    closeAllSockets(h.plane, 1001, "server restart");
    await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
    const second = eventsAs(h, "ready")[1];
    expect(second).toMatchObject({ maintenance: { on: true, changedAt: STAMP } });
    expect(h.plane.unparsed).toEqual([]);
  });

  test("ready carries an UNREADABLE mirror, stamped with the file's own mtime", async () => {
    // A node that refuses every launch must say so. Reporting nothing left
    // the plane showing it launchable with every create 409ing, and the file
    // is only ever repaired by the plane pushing a clean one back.
    const h = await startDaemon();
    await waitForReady(h);
    writeFileSync(maintenancePath(h.config.dataDir), "{not json");
    closeAllSockets(h.plane, 1001, "server restart");
    await waitFor(h, () => h.plane.events.filter((e) => e.type === "ready").length >= 2, "reconnect ready");
    const second = eventsAs(h, "ready")[1];
    expect(second).toMatchObject({
      maintenance: { on: true, changedAt: statSync(maintenancePath(h.config.dataDir)).mtime.toISOString() },
    });
    expect(h.plane.unparsed).toEqual([]);
  });

  test("a flip after connect lands as ONE maintenance event on the next heartbeat tick", async () => {
    // The belt for a flip with no running panes: nothing dies, so the
    // reportDeath path never runs and the heartbeat is the only thing left
    // that notices.
    const h = await startDaemon({ heartbeatMs: 30 });
    await waitForReady(h);
    expect(count(h, (e) => e.type === "maintenance")).toBe(0);
    writeMaintenance(h.config.dataDir, { on: true, changedAt: STAMP });
    const ev = await waitFor(h, (e) => e.type === "maintenance", "maintenance event");
    expect(ev).toMatchObject({ type: "maintenance", on: true, changedAt: STAMP });
    await sleep(150); // ~5 more ticks: the memo must stop it repeating
    expect(count(h, (e) => e.type === "maintenance")).toBe(1);
    expect(h.plane.unparsed).toEqual([]);
  });

  test("a second flip is reported again — the memo tracks the value, not the fact of having reported", async () => {
    const h = await startDaemon({ heartbeatMs: 30 });
    await waitForReady(h);
    writeMaintenance(h.config.dataDir, { on: true, changedAt: STAMP });
    await waitFor(h, (e) => e.type === "maintenance" && e.on, "first flip");
    writeMaintenance(h.config.dataDir, { on: false, changedAt: "2026-09-14T12:00:00.000Z" });
    const off = await waitFor(h, (e) => e.type === "maintenance" && !e.on, "second flip");
    expect(off).toMatchObject({ on: false, changedAt: "2026-09-14T12:00:00.000Z" });
  });
});

describe("the update transaction, settled by the daemon (spec 2026-09-15 §5.1/§5.2)", () => {
  /**
   * The kept copy, as a stub EXECUTABLE that answers `version`.
   *
   * The 4406 revert PROBEs `.previous` before renaming it back (round-3
   * review, finding 2 — the daemon calls `revertAfterRefusal` with the
   * default probe), so the fixture must be a file the probe lets through:
   * the shape `node-update.sh` proves with two compiled binaries, shrunk to
   * a shebang here.
   */
  const OLD_STUB = '#!/bin/sh\necho "subshell 0.8.0"\n';

  /** Write a pending marker as `applyUpdate` would, plus the `.previous` it names. */
  function stageTransaction(dataDir: string): { binary: string; previous: string } {
    const binary = join(dataDir, "subshell");
    const previous = `${binary}.previous`;
    writeFileSync(binary, "NEW");
    writeFileSync(previous, OLD_STUB);
    chmodSync(previous, 0o755);
    writeFileSync(
      join(dataDir, "update-pending.json"),
      JSON.stringify({
        from: "0.8.0",
        to: "9.9.9",
        binary,
        previousBinary: previous,
        startedAt: "2026-09-15T00:00:00.000Z",
        origin: "plane",
      }),
    );
    return { binary, previous };
  }

  test("a verified non-update command settles it: `.previous` and the marker are dropped", async () => {
    // The plane pushes `set_allowed_dirs` on every accepted `ready`
    // (`services/nodes/allowed-dirs-sync.ts`), so in production this is the
    // path that always runs — the timer beside it is a belt, and it is
    // deliberately LONGER than the plane's ten-minute hold budget.
    const h = await startDaemon();
    await waitForReady(h);
    const { binary, previous } = stageTransaction(h.config.dataDir);
    // A VERIFIED command, not any frame: a held plane sends `update` and
    // nothing else, so "anything at all" cannot be the signal. Verification
    // is what proves this plane is talking TO this binary.
    await signAndSend(h, { type: "set_allowed_dirs", dirs: [] });
    const deadline = Date.now() + 2000;
    while (existsSync(previous) && Date.now() < deadline) await sleep(10);
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(join(h.config.dataDir, "update-pending.json"))).toBe(false);
    expect(readFileSync(binary, "utf8")).toBe("NEW");
  });

  test("an `update` command does NOT settle it — that frame is what a HELD plane sends", async () => {
    // The bug this pins: a plane that REFUSED this binary holds the socket and
    // sends exactly one thing, the `update` that rescues the machine. Settling
    // on it dropped `.previous` and the marker BEFORE the rescue ran, so a
    // rescue that then failed left nothing to roll back to and the 4406 ten
    // minutes later stranded the node on the incompatible binary.
    const h = await startDaemon();
    await waitForReady(h);
    const { binary, previous } = stageTransaction(h.config.dataDir);

    // A deliberately unreachable source, so the update FAILS the way a
    // forgotten token or a moved artifact would.
    await signAndSend(h, {
      type: "update",
      version: "9.9.9",
      url: "http://127.0.0.1:1/subshell-node-cli-linux-x64",
      sha256: "0".repeat(64),
    });
    const deadline = Date.now() + 5000;
    while (eventsAs(h, "result").length === 0 && Date.now() < deadline) await sleep(10);

    // The rescue failed, and the transaction it was sent to rescue is STILL
    // open: the rollback path has something to put back.
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(join(h.config.dataDir, "update-pending.json"))).toBe(true);
    expect(readFileSync(binary, "utf8")).toBe("NEW");
  });

  test("close 4406 with a pending marker ROLLS BACK, records the failure, and exits 1", async () => {
    const h = await startDaemon();
    await waitForReady(h);
    const { binary, previous } = stageTransaction(h.config.dataDir);
    h.plane.socket?.close(4406, "protocol v11 required (this node speaks v10)");
    const deadline = Date.now() + 2000;
    while (h.exits.length === 0 && Date.now() < deadline) await sleep(5);
    expect(h.exits).toEqual([1]);
    // The previous binary is back where the service manager will find it —
    // the revert PROBE ran it (`version`, exit 0) before renaming, and the
    // stub answers, so this is the ordinary swap-back (finding 2's refusal
    // path is pinned with the real probe in `__tests__/update.test.ts`).
    expect(readFileSync(binary, "utf8")).toBe(OLD_STUB);
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(join(h.config.dataDir, "update-pending.json"))).toBe(false);
    const failed = JSON.parse(readFileSync(join(h.config.dataDir, "update-failed.json"), "utf8")) as {
      to: string;
      reason: string;
    };
    expect(failed.to).toBe("9.9.9");
    expect(failed.reason).toContain("protocol v11");
  });

  test("close 4406 WITHOUT a marker touches nothing — it is the ordinary too-old refusal", async () => {
    // A plane refusing an agent nobody just updated is the commonest 4406 by
    // far. Inventing a swap there would move files for an update that never
    // happened.
    const h = await startDaemon();
    await waitForReady(h);
    h.plane.socket?.close(4406, "subshell 0.9.0 or newer required (this node is 0.8.0)");
    const deadline = Date.now() + 2000;
    while (h.exits.length === 0 && Date.now() < deadline) await sleep(5);
    expect(h.exits).toEqual([1]);
    expect(existsSync(join(h.config.dataDir, "update-failed.json"))).toBe(false);
  });
});

describe("pane-log retention wiring", () => {
  test("the pass starts at boot, and again on its period", async () => {
    // Boot-first still matters most: a node that was OFFLINE while a subshell
    // was deleted (or simply idle past its window) begins aging the transcript
    // out the moment the agent starts, before the plane asks anything. What
    // finding 2 changed is only that the pass is SCHEDULED before the dial,
    // not awaited by it.
    let passes = 0;
    const h = await startDaemon({ retentionPass: async () => void passes++, retentionMs: 30 });
    expect(passes).toBeGreaterThanOrEqual(1); // the boot pass was started before the first dial completed
    // A finite boot (the default one-day window) arms the hourly timer, and
    // the daemon states that boot decision to the retention endpoints so the
    // dashboard's copy promises a sweep that actually runs (finding 5).
    expect(sweepIsScheduled()).toBe(true);
    const deadline = Date.now() + 2000;
    while (passes < 3 && Date.now() < deadline) await sleep(10);
    expect(passes).toBeGreaterThanOrEqual(3);
    void h;
  });

  test("a boot sweep that never finishes does not gate the first dial (finding 2)", async () => {
    // The census is one tmux probe per meta record; on a wedged host an
    // AWAITED boot pass stalled the node's first connection for N × the 15 s
    // timeout. The pass now shares the hourly beat's fire-and-forget posture:
    // `startDaemon` itself awaits the first `ready`, so if the daemon were
    // still awaiting a hung pass this test would hang, not fail.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    try {
      const h = await startDaemon({
        retentionPass: async () => {
          started += 1; // synchronous: proves the pass was SCHEDULED before the dial
          await gate; // and never resolves on its own — the dial must not care
        },
        retentionMs: 3_600_000, // one hung boot pass only (the timer stays effectively off)
      });
      expect(started).toBe(1);
      expect(eventTypes(h)[0]).toBe("ready"); // the socket is up while the sweep is still hung
    } finally {
      release();
    }
  });

  test("keep-forever (0 days + 0 hours) runs no pass at all", async () => {
    let passes = 0;
    const h = await startDaemon({
      retentionPass: async () => void passes++,
      retentionMs: 30,
      config: { logRetentionDays: 0, logRetentionHours: 0 },
    });
    await sleep(120);
    expect(passes).toBe(0);
    // The boot decision is stated for the dashboard too: this shape scheduled
    // no timer, so the retention card must promise the restart and not a pass
    // (finding 5 — the truth the old stored-derived sentence got backwards).
    expect(sweepIsScheduled()).toBe(false);
    void h;
  });

  test("the default pass re-reads config.json: a write lands without a restart (R3)", async () => {
    // The live-effect half of the dashboard's setter, through the REAL default
    // pass (no spy): boot says 30 days, so a two-day-old transcript survives;
    // the config file is then rewritten to `0 + 1` mid-run — exactly what
    // `PUT /api/self/log-retention` does — and the next scheduled sweep
    // deletes the file. Nothing restarts; the pass itself re-resolves.
    const h = await startDaemon({ config: { logRetentionDays: 30 }, retentionMs: 30 });
    const dir = join(h.config.dataDir, "subshells");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "aaaaaaaa-0000-4000-8000-0000000000aa.log");
    writeFileSync(file, "typed transcript\n");
    const t = (Date.now() - 2 * 24 * 3_600_000) / 1000;
    utimesSync(file, t, t);
    await sleep(80); // a few 30-day passes: the file is inside the window
    expect(existsSync(file)).toBe(true);

    await saveConfig({ ...h.config, logRetentionDays: 0, logRetentionHours: 1 });
    const deadline = Date.now() + 2000;
    while (existsSync(file) && Date.now() < deadline) await sleep(10);
    expect(existsSync(file)).toBe(false);
  });

  test("SUBSHELL_LOG_RETENTION_* forces the config aside — environment wins", async () => {
    // config.json says keep-forever; the environment says sweep hourly. The
    // pass must run anyway (it is a spy — the sweep's own semantics are
    // tested in pane-log-retention.test.ts; this pins the precedence wire).
    process.env.SUBSHELL_LOG_RETENTION_HOURS = "1";
    try {
      let passes = 0;
      const h = await startDaemon({
        retentionPass: async () => void passes++,
        retentionMs: 30,
        config: { logRetentionDays: 0, logRetentionHours: 0 },
      });
      expect(passes).toBeGreaterThanOrEqual(1);
      void h;
    } finally {
      delete process.env.SUBSHELL_LOG_RETENTION_HOURS;
    }
  });
});
