import { hostname } from "node:os";
import {
  type CommandClaims,
  type JsonValue,
  JtiLru,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeCommandBody,
  type NodeEvent,
  SeqTracker,
  verifyCommand,
} from "@internal/session-protocol";
import { backoffDelay } from "./backoff.js";
import type { AgentConfig } from "./config.js";
import { mapOs } from "./enroll.js";
import { buildInventoryEvent } from "./inventory.js";
import { clearLock, writeLock } from "./lock.js";
import { AGENT_VERSION } from "./version.js";

/**
 * `mote-agent run` — the signed-frame execution loop (spec 2026-08-31 §7).
 *
 * Direction of trust: the socket is authenticated by the bearer node key at
 * upgrade (so outbound events are unsigned — §3.3), while every inbound
 * command must carry a JWS the pinned control key signed (§4). Stateful
 * verify inputs keep their documented lifetimes: the jti LRU is PER-PROCESS
 * (a reconnect must not reopen the replay window), the SeqTracker is
 * PER-CONNECTION (reset on every open — ordering only means something within
 * one stream).
 *
 * Everything testable is injected through {@link DaemonDeps}: the clock, the
 * jitter source, the process-exit hook (NEVER a direct `process.exit` in this
 * file), and the WebSocket constructor. Logging is a plain timestamped
 * one-liner to stdout — deliberately not LogLayer (the lean-binary posture;
 * the §7 dep line divergence is accepted for phase 1).
 */

/**
 * Terminal close codes (spec §5.3): 4409 — another agent superseded this
 * node's identity; 4406 — protocol mismatch, the agent binary must be
 * updated. The values live in `@internal/session-protocol` (phase-2 hoist,
 * shared with the backend) and are re-exported through here unchanged so the
 * library surface in `src/index.ts` stays green.
 */
export { NODE_CLOSE_SUPERSEDED, NODE_CLOSE_UPDATE_REQUIRED };

/** Steady-state heartbeat period (spec §5.3). */
export const HEARTBEAT_MS = 15_000;

/** Cap for the jti→result idempotence cache (FIFO; defense-in-depth over the jti LRU). */
const IDEMPOTENCE_CAP = 256;

/** Wall-clock cap for the `status` connect probe (brief T13: "5 s"). */
const STATUS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Emit one timestamped daemon log line. stdout: `mote-agent run` is a
 * foreground process and its operator (or the phase-3 service unit) reads
 * both streams anyway.
 */
export function log(...parts: unknown[]): void {
  console.log(`[mote-agent ${new Date().toISOString()}]`, ...parts);
}

/** The client surface the daemon uses; Bun's `WebSocket` satisfies it structurally. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

/**
 * Constructor shape: Bun's WebSocket client accepts `{ headers }` as its
 * second argument (undici does not — and @types/bun doesn't surface the
 * overload), hence the explicit type + the `as unknown as` cast where the
 * global is adopted. The daemon tests prove it at runtime against a real
 * `Bun.serve` plane (the plane refuses the upgrade without the bearer header).
 */
export type WsConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WsLike;

/** Injectable seams (all optional; production calls `runDaemon(config)`). */
export interface DaemonDeps {
  /** Epoch-ms clock (default wall clock) — stamps heartbeat/inventory `ts`. */
  now?: () => number;
  /** Jitter source in [0, 1) for the backoff (default `Math.random`). */
  rand?: () => number;
  /**
   * Process-exit hook (default `process.exit`). Typed `never`-returning:
   * tests inject a thrower so the loop unwinds cleanly instead of killing
   * the test process.
   */
  exit?: (code: number) => never;
  /** WebSocket client implementation (default `globalThis.WebSocket`). */
  WebSocketImpl?: WsConstructor;
  /** Heartbeat period, ms (default {@link HEARTBEAT_MS}). */
  heartbeatMs?: number;
}

type CachedResult = { ok: true; data?: JsonValue } | { ok: false; error: string };

interface WsClose {
  /** Close code observed on the socket (1006 when the transport just died). */
  code: number;
  /** Close reason text (may be empty). */
  reason: string;
}

/**
 * Derive the node websocket URL from the control plane's base URL.
 * `https → wss`, `http → ws` (the only schemes `normalizeServer` accepts),
 * path `/ws/node`. CAVEAT (phase-1 proxy divergence): a control plane served
 * under a reverse-proxy SUBPATH (`https://host/mote`) needs that prefix kept
 * on the ws path too; we append to the configured base verbatim, which is
 * correct for same-origin mounts and root-mounted proxies only.
 * @param serverUrl - the `serverUrl` from the config file
 * @returns the dial target for the node socket
 */
export function wsUrlFor(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/ws/node`;
}

/** Parse the config's pinned control key; a broken pin is fatal (commands could never verify). */
function parsePinnedKey(serialized: string): JsonWebKey {
  try {
    return JSON.parse(serialized) as JsonWebKey;
  } catch {
    throw new Error("pinned control key in the config is not valid JSON — re-run mote-agent enroll to repin it");
  }
}

/**
 * Best-effort `jti` extraction from an already-rejected envelope — used ONLY as
 * the idempotence-map key on the `replay` path. Safe by construction: `replay` is
 * returned only after the signature over these exact bytes verified, so the payload
 * is authentic; the decoded claims are never executed or trusted beyond the lookup.
 * @param jws - the compact JWS whose verify failed with `replay`
 * @returns the payload's `jti` when it parses to a string, else undefined
 */
function jtiOfUnverified(jws: string): string | undefined {
  const payload = jws.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { jti?: unknown };
    return typeof claims.jti === "string" ? claims.jti : undefined;
  } catch {
    return undefined;
  }
}

/** The `ready` frame: machine identity + protocol version (spec §3.3/§5.3). */
function readyEvent(config: AgentConfig): Extract<NodeEvent, { type: "ready" }> {
  return {
    type: "ready",
    agentVersion: AGENT_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: mapOs(process.platform),
    arch: process.arch,
    hostname: hostname(),
    dataDir: config.dataDir,
    capabilities: [], // phase 1: no mcp subcommand, no uploads (spec §7 capability flags)
  };
}

/**
 * The reconnect loop: connect → `ready` + heartbeat → verify-and-execute signed
 * commands → backoff-and-retry on any non-terminal close. Terminal closes
 * (4409 superseded, 4406 update-required) exit the process with code 1 through
 * the injected `exit` (spec §5.3/F); SIGINT/SIGTERM exit 0 — closing the socket cleanly
 * (1000) when one is attached, and aborting the backoff sleep within 250 ms when one is
 * not, so the first Ctrl-C always wins. Never resolves otherwise.
 *
 * Local liveness contract with `mote-agent status`: a `daemon.lock` ({pid, startedAt,
 * nodeId, lastTickAt}) is written under the agent home at startup, refreshed on every
 * heartbeat tick, and removed on every exit path — so `status` never needs to dial.
 *
 * @param config - the enrolled node's config (server, ids, pinned control key)
 * @param deps - test seams; production omits them entirely
 * @returns `never` — resolves only if the injected `exit` returns (test seam)
 */
export async function runDaemon(config: AgentConfig, deps: DaemonDeps = {}): Promise<never> {
  const rand = deps.rand ?? Math.random;
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const WebSocketImpl = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsConstructor);
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const nowMs = deps.now ?? ((): number => Date.now());
  const wsUrl = wsUrlFor(config.serverUrl);
  const controlPublicKey = parsePinnedKey(config.controlPublicKey);

  // PER-PROCESS lifetimes (mixing these up is a security bug — see VerifyContext in node-signing):
  const jtiLru = new JtiLru(); // survives every reconnect: a replayed jti never gets a second evaluation
  const seqTracker = new SeqTracker(); // per-CONNECTION value; reset on every open below
  // jti → result cache: the `replay` verify path re-answers a double-delivered command
  // from here (and so does execute(), should the LRU ever evict inside the TTL window) —
  // a jti that has run once NEVER runs twice.
  const idempotent = new Map<string, CachedResult>();

  // Local-liveness lock for `mote-agent status` (fix wave 1). Best-effort: a home that
  // cannot hold the file degrades `status`, never the daemon.
  const startedAt = new Date(nowMs()).toISOString();
  const writeLiveness = (): void => {
    try {
      writeLock({ pid: process.pid, startedAt, nodeId: config.nodeId, lastTickAt: new Date(nowMs()).toISOString() });
    } catch (err) {
      log(`cannot maintain daemon.lock: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  writeLiveness();

  let socket: WsLike | undefined;
  let shuttingDown = false;
  // No socket attached (we are between connections / inside the backoff sleep)? Setting
  // the flag is enough: the sliced sleep notices it within 250 ms and the loop exits 0
  // BEFORE dialing again — the first Ctrl-C always wins.
  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("signal received — closing the connection (graceful exit)");
    try {
      socket?.close(1000, "shutdown");
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let attempt = 0;

  const send = (ws: WsLike, ev: NodeEvent): void => {
    try {
      ws.send(JSON.stringify(ev));
    } catch (err) {
      log(`send ${ev.type} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** The ONE exit path: clears `daemon.lock` FIRST (the real `exit` never returns), then defers. */
  const stop = (code: number): never => {
    try {
      clearLock(process.pid); // ownership-checked: never deletes a survivor's lock
    } catch (err) {
      log(`cannot clear daemon.lock: ${err instanceof Error ? err.message : String(err)}`);
    }
    return exit(code); // never-typed: neither the real nor the injected exit ever returns
  };

  /**
   * Backoff sleep in ≤250 ms slices, aborting the moment shutdown begins — a signal
   * during a 60 s capped sleep must not cost 60 s of shutdown latency (fix wave 1).
   */
  const sleepCancellable = async (ms: number): Promise<void> => {
    const until = Date.now() + ms;
    while (!shuttingDown && Date.now() < until) {
      await new Promise<void>((r) => setTimeout(r, Math.max(0, Math.min(250, until - Date.now()))));
    }
  };

  /** Run ONE verified command; every jti lands in the idempotence map (uniform, cheap). */
  const execute = async (ws: WsLike, claims: CommandClaims): Promise<void> => {
    const cached = idempotent.get(claims.jti);
    if (cached) {
      // Replay slipped past the LRU (post-eviction): answer from cache, NEVER re-execute.
      send(ws, { type: "result", ref: claims.jti, ...cached });
      return;
    }
    const result = await dispatch(ws, claims.cmd);
    idempotent.set(claims.jti, result);
    if (idempotent.size > IDEMPOTENCE_CAP) {
      const oldest = idempotent.keys().next().value as string | undefined;
      if (oldest !== undefined) idempotent.delete(oldest);
    }
    send(ws, { type: "result", ref: claims.jti, ...result });
  };

  /** The phase-1 command switch: ping + inventory execute, everything else answers `unsupported`. */
  const dispatch = async (ws: WsLike, cmd: NodeCommandBody): Promise<CachedResult> => {
    switch (cmd.type) {
      case "ping":
        return { ok: true, data: "pong" };
      case "inventory":
        try {
          // Event FIRST (the server persists from it), result second — matches the
          // server's fire-and-forget handler best-effort (phase-2 carry: serialize).
          send(ws, await buildInventoryEvent(nowMs()));
          return { ok: true };
        } catch (err) {
          return { ok: false, error: `inventory: ${err instanceof Error ? err.message : String(err)}` };
        }
      default:
        // launch/terminate/input/... land in phase 2; the `unsupported` answer is
        // the integration contract that lets both tracks move independently (spec §7).
        return { ok: false, error: "unsupported" };
    }
  };

  /** One inbound frame: byte guard → jws extraction → verify → execute (spec §4). */
  const onFrame = async (ws: WsLike, data: unknown): Promise<void> => {
    if (typeof data !== "string") {
      log("ignored non-text frame");
      return;
    }
    const size = new Blob([data]).size;
    if (size > NODE_MAX_FRAME_BYTES) {
      // Ignore, do NOT close: the server already guards its own direction, so an
      // oversize inbound frame is hostile noise — answer nothing.
      log(`oversize frame ignored (${size} bytes > ${NODE_MAX_FRAME_BYTES})`);
      return;
    }
    let jws: unknown;
    try {
      jws = (JSON.parse(data) as { jws?: unknown }).jws;
    } catch {
      jws = undefined;
    }
    if (typeof jws !== "string") {
      send(ws, { type: "error", code: "verify", message: "malformed" });
      return;
    }
    const outcome = await verifyCommand(jws, controlPublicKey, {
      nodeId: config.nodeId,
      jtiLru,
      seqTracker,
    });
    if (!outcome.ok) {
      // EVERY verify failure — `replay` included — answers with the error event
      // (brief §4: the control plane must SEE the anomaly); skipping the switch-entry
      // below is all a failure costs. (The fix-wave-1 revert of the old replay-silence
      // divergence — the brief governs.)
      send(ws, { type: "error", code: "verify", message: outcome.reason });
      if (outcome.reason === "replay") {
        // SILENT about EXECUTING — but if this jti ran before, the per-process
        // idempotence map re-sends its answer, so a double-delivery still gets a
        // response alongside the anomaly telemetry. (No cache → error event only.)
        log("dropped replayed command (jti already seen)");
        const seenJti = jtiOfUnverified(jws);
        const cached = seenJti === undefined ? undefined : idempotent.get(seenJti);
        if (seenJti !== undefined && cached) send(ws, { type: "result", ref: seenJti, ...cached });
        return;
      }
      if (outcome.reason === "seq") {
        // Spec §4: a seq regression drops the CONNECTION — the reconnect starts a
        // fresh SeqTracker (ordering is per-stream), while the jti LRU stays warm.
        log("seq regression — dropping connection (spec §4)");
        try {
          ws.close(1000, "seq regression");
        } catch {
          /* already closing */
        }
      }
      return;
    }
    await execute(ws, outcome.claims);
  };

  /** Open one socket; resolves with the close event when the stream ends. */
  const runConnection = (): Promise<WsClose> =>
    new Promise<WsClose>((resolve, reject) => {
      seqTracker.reset(); // PER-CONNECT: ordering restarts on a fresh stream (spec §4)
      let ws: WsLike;
      try {
        ws = new WebSocketImpl(wsUrl, { headers: { Authorization: `Bearer ${config.nodeKey}` } });
      } catch (err) {
        reject(new Error(`cannot open ${wsUrl}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      socket = ws;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let settled = false;
      const finish = (close: WsClose): void => {
        if (settled) return;
        settled = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (socket === ws) socket = undefined;
        resolve(close);
      };
      ws.addEventListener("open", () => {
        attempt = 0; // a successful open resets the backoff ladder
        log(`connected ${wsUrl} as node ${config.nodeId}`);
        send(ws, readyEvent(config));
        heartbeat = setInterval(() => {
          send(ws, { type: "heartbeat", ts: new Date(nowMs()).toISOString() });
          writeLiveness(); // every heartbeat tick doubles as the local-liveness refresh
        }, heartbeatMs);
      });
      ws.addEventListener("message", (ev) => {
        void onFrame(ws, ev.data).catch((err: unknown) => log(`frame handling error: ${String(err)}`));
      });
      ws.addEventListener("close", (ev) => finish({ code: ev?.code ?? 1006, reason: ev?.reason ?? "" }));
      ws.addEventListener("error", () => {
        // A real WebSocket always follows `error` with `close`; finish defensively
        // in case an implementation ever surfaces only the error.
        if (ws.readyState >= 2) finish({ code: 1006, reason: "socket error" });
      });
    });

  try {
    for (;;) {
      // Pre-dial check: a signal that landed while detached or during the (sliced)
      // backoff sleep exits 0 here — the first Ctrl-C never waits out a sleep or a dial.
      if (shuttingDown) stop(0);
      const close = await runConnection();
      if (shuttingDown) stop(0); // graceful: the socket closed cleanly on our request
      if (close.code === NODE_CLOSE_SUPERSEDED) {
        log(
          `another mote-agent is already registered as node '${config.nodeId}' (close 4409) — exiting; stop the duplicate agent first`,
        );
        stop(1);
      }
      if (close.code === NODE_CLOSE_UPDATE_REQUIRED) {
        log(
          `the control plane rejected protocol v${NODE_PROTOCOL_VERSION} (close 4406) — a newer mote-agent is required; exiting`,
        );
        stop(1);
      }
      const delay = backoffDelay(attempt++, rand);
      log(
        `disconnected (code ${close.code}${close.reason ? `: ${close.reason}` : ""}) — reconnecting in ${Math.round(delay)} ms`,
      );
      await sleepCancellable(delay);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      clearLock(process.pid); // every unwind path (incl. the test seams that throw through exit)
    } catch {
      /* best-effort */
    }
  }
}

/** Extra seams for {@link probeOnline}. */
export interface OnlineProbeDeps {
  /** WebSocket client implementation (default `globalThis.WebSocket`). */
  WebSocketImpl?: WsConstructor;
  /** Open-wait cap in ms (default 5 s). */
  timeoutMs?: number;
}

/**
 * The `status` probe: open a short-lived node socket, send NOTHING, online =
 * the open completed inside the cap. Then close with 1000.
 *
 * NOTE (destructive by design): the control plane's registry attaches at OPEN
 * and is newest-wins, so probing while `mote-agent run` is live on this node
 * supersede-kicks the running agent (it treats 4409 as terminal). That is why
 * `mote-agent status` calls this ONLY on the explicit `--probe` opt-in (fix
 * wave 1); its default path reads the local `daemon.lock` and never dials. A
 * REST-based `status` reading the node row remains the phase-2 upgrade — see
 * the task report.
 *
 * @param config - the enrolled node's config
 * @param deps - seams for tests
 * @returns true when a socket opened within the cap
 */
export function probeOnline(config: AgentConfig, deps: OnlineProbeDeps = {}): Promise<boolean> {
  const WebSocketImpl = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsConstructor);
  const timeoutMs = deps.timeoutMs ?? STATUS_PROBE_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (online: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(online);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    let ws: WsLike;
    try {
      ws = new WebSocketImpl(wsUrlFor(config.serverUrl), { headers: { Authorization: `Bearer ${config.nodeKey}` } });
    } catch {
      done(false);
      return;
    }
    ws.addEventListener("open", () => {
      done(true);
      try {
        ws.close(1000, "status probe");
      } catch {
        /* already closing */
      }
    });
    ws.addEventListener("close", () => done(false)); // refused/closed before we counted it
    ws.addEventListener("error", () => done(false));
  });
}
