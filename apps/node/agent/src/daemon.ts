import { hostname } from "node:os";
import { TmuxRunner } from "@internal/pane-runtime";
import {
  type CommandClaims,
  JtiLru,
  NODE_CLOSE_SUPERSEDED,
  NODE_CLOSE_UPDATE_REQUIRED,
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  type NodeEvent,
  type NodeRuntimeReport,
  SeqTracker,
  verifyCommand,
} from "@internal/subshell-protocol";
import { backoffDelay } from "./backoff.js";
import type { CommandContext, CommandResult, CommandWs } from "./commands/context.js";
import { dispatchCommand } from "./commands/index.js";
import { buildSubshellsReport } from "./commands/report.js";
import { stopAllTails } from "./commands/tail.js";
import { cleanupStaleUploads } from "./commands/write-file.js";
import type { AgentConfig } from "./config.js";
import { loadAndApplyDebugLogging } from "./debug-logging.js";
import { mapOs } from "./enroll.js";
import { reportHomeDir } from "./host-env.js";
import { buildInventoryEvent } from "./inventory.js";
import { clearLock, writeLock } from "./lock.js";
import { log } from "./log.js";
import { collectRuntime } from "./runtime.js";
import { selfInvokePrefix } from "./self-invoke.js";
import { SubshellMetaStore } from "./subshell-meta.js";
import { AGENT_VERSION } from "./version.js";

/**
 * `subshell run` — the signed-frame execution loop (spec 2026-08-31 §7).
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
 * updated. The values live in `@internal/subshell-protocol` (hoisted so the
 * daemon's terminal-close check and the backend registry share one source);
 * `src/index.ts` re-exports them from the package directly.
 */
/** Steady-state heartbeat period (spec §5.3). */
export const HEARTBEAT_MS = 15_000;

/**
 * Periodic `inventory` push period — the "every 5 min" leg of spec §7
 * ("Inventory every 5 min + on demand"; P3-T8c shipped what T8b's
 * connect-time beat left open). The launch gate's snapshot TTL is ~10 min,
 * so without this leg a long-lived healthy node 409'd every new launch once
 * its connect-time snapshot aged out.
 */
export const INVENTORY_PERIOD_MS = 300_000;

/**
 * How long a `restart` waits before taking the socket down (spec 2026-09-12
 * § 6.3). Long enough that the `result { ok: true }` frame has left, short
 * enough that the plane's waiter sees the node drop promptly.
 */
export const RESTART_EXIT_DELAY_MS = 250;

/** Cap for the jti→result idempotence cache (FIFO; defense-in-depth over the jti LRU). */
const IDEMPOTENCE_CAP = 256;

/** Wall-clock cap for the `status` connect probe (brief T13: "5 s"). */
const STATUS_PROBE_TIMEOUT_MS = 5_000;

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
  /** Periodic inventory push period, ms (default {@link INVENTORY_PERIOD_MS}). */
  inventoryMs?: number;
  /**
   * tmux runner for the command executors (default `new TmuxRunner()`).
   * @internal test seam — production never passes one.
   */
  tmux?: TmuxRunner;
  /**
   * Subshell-meta store for the executors (default `new SubshellMetaStore(config.dataDir)`).
   * @internal test seam — production never passes one.
   */
  meta?: SubshellMetaStore;
  /**
   * The runtime report to send in `ready` (default: one `collectRuntime()`
   * at daemon start, degraded to null if the service read throws).
   * @internal test seam — pass `null` to skip the `service status` spawn.
   */
  runtime?: NodeRuntimeReport | null;
}

interface WsClose {
  /** Close code observed on the socket (1006 when the transport just died). */
  code: number;
  /** Close reason text (may be empty). */
  reason: string;
}

/**
 * Derive the node websocket URL from the control plane's base URL.
 * `https → wss`, `http → ws` (the only schemes `normalizeServer` accepts),
 * path `/ws/node`. RESOLUTION NOTE (ledger 17c, replaces the phase-1
 * subpath-proxy caveat): enroll now persists the URL the SERVER reported
 * (`config.nodeWsUrl`) and {@link resolveWsUrl} prefers it — a control plane
 * mounted under a reverse-proxy subpath is dialed exactly as it described
 * itself at enroll, never re-guessed. This derivation is the fallback only
 * for pre-17c (or hand-written) configs that carry no server answer.
 * @param serverUrl - the `serverUrl` from the config file
 * @returns the derived dial target for the node socket
 */
export function wsUrlFor(serverUrl: string): string {
  // Case-INSENSITIVE, as defence rather than as the primary guard:
  // `normalizeServer` lower-cases the scheme before anything is persisted, so
  // a config written by `enroll`/`configure` always arrives lower-case. This
  // covers a hand-edited `config.json`, where the case-sensitive form silently
  // produced `HTTP://…/ws/node` — not a WebSocket URL, and no error naming it.
  const lowerScheme = serverUrl.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
  return `${lowerScheme.replace(/^http/, "ws")}/ws/node`;
}

/**
 * The ONE dial-URL resolution for the node socket (ledger 17c): the
 * server-reported URL persisted at enroll when present, else the derivation
 * from `serverUrl`. Both `runDaemon` and `probeOnline` resolve through here,
 * so `run` and `status --probe` can never dial different endpoints for the
 * same node.
 * @param config - the enrolled node's config
 */
function resolveWsUrl(config: AgentConfig): string {
  return config.nodeWsUrl ?? wsUrlFor(config.serverUrl);
}

/** Parse the config's pinned control key; a broken pin is fatal (commands could never verify). */
function parsePinnedKey(serialized: string): JsonWebKey {
  try {
    return JSON.parse(serialized) as JsonWebKey;
  } catch {
    throw new Error("pinned control key in the config is not valid JSON. Re-run subshell enroll to repin it");
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

/**
 * Capability gate for the `subshell mcp` subcommand — shipped since Task 13
 * (the `@internal/mcp-core` server behind `subshell mcp`), so this build advertises `mcp`
 * alongside `uploads` in `readyEvent` and the control plane registers the
 * per-subshell MCP config for launches on this node. The constant is the kill
 * switch: flip it false (with the command removed from `cli.ts`) and the
 * backend's capability gate skips registration for every subshell launched here.
 */
const HAS_MCP = true;

/** The `ready` frame: machine identity + protocol version (spec §3.3/§5.3). */
/**
 * What this host prints when the control plane refuses it with 4406.
 *
 * RELAYS the server's reason, because it is the only place the operator learns
 * WHICH gate refused them: the agent-version floor names the version required
 * and the version found, the protocol backstop names both protocol numbers,
 * and this host cannot work out which applied. The previous line asserted a
 * protocol mismatch unconditionally — wrong for the commoner of the two
 * refusals, and it named a number that was not the problem.
 *
 * Pure and exported so the wording is testable: `log` is a module import here,
 * and a message an operator is expected to act on should not be verifiable
 * only by capturing stdout.
 *
 * @param reason - the server's close reason, empty when it sent none
 * @returns The line to print before exiting
 */
export function updateRequiredMessage(reason: string | undefined): string {
  return reason
    ? `the control plane refused this agent (close 4406): ${reason}; exiting`
    : `the control plane refused this agent (close 4406); a newer subshell is required; exiting`;
}

function readyEvent(config: AgentConfig, runtime: NodeRuntimeReport | null): Extract<NodeEvent, { type: "ready" }> {
  return {
    type: "ready",
    agentVersion: AGENT_VERSION,
    protocolVersion: NODE_PROTOCOL_VERSION,
    os: mapOs(process.platform),
    arch: process.arch,
    hostname: hostname(),
    dataDir: config.dataDir,
    // Phase 2 (Task 4): the capability set advertises the phase-2 command
    // surface. `uploads` names the terminal-upload relay pipeline; `mcp`
    // (HAS_MCP, shipped in Task 13) is what lets the control plane register
    // `subshell mcp` for subshells launched here.
    capabilities: HAS_MCP ? ["uploads", "mcp"] : ["uploads"],
    // How to re-enter this binary, not `process.execPath`: under an
    // interpreter run execPath is `bun`, and `bun mcp` is not a command —
    // every pane launched by a source-run agent would get an MCP registration
    // that cannot start. `selfInvokePrefix` answers the
    // compiled-versus-interpreted question (its header records the original
    // bug), and the control plane appends the verb it needs — `mcp` for a
    // pane's MCP registration, `report` for its harness hooks — composing
    // each from the result verbatim; the node writes what the plane sends, it
    // recomputes nothing (launch.ts, inversion §5).
    //
    // UNCONDITIONAL, unlike the `mcp` capability beside it: this is a fact
    // about the binary rather than a feature of it, and the hooks need it on
    // an agent that advertises no mcp at all.
    selfInvoke: selfInvokePrefix(),
    // Spec 2026-09-10 §5: the fallback root for resume paths the control
    // plane computes. The env VALUES a resume path may need are no longer
    // reported here — the node holds no manifests to know the names (§6);
    // they answer on the plane's `detect` round trip (host-env.ts).
    homeDir: reportHomeDir(),
    // How this process runs (spec 2026-09-12 § 6.1) — collected once before
    // the connect loop, so the frame is still built synchronously here.
    // Omitted rather than nulled when the read failed: the field is optional
    // on the wire and the plane simply shows no card.
    ...(runtime ? { runtime } : {}),
  };
}

/**
 * The reconnect loop: connect → `ready` + heartbeat + periodic inventory
 * (spec §7) → verify-and-execute signed commands → backoff-and-retry on any
 * non-terminal close. Terminal closes
 * (4409 superseded, 4406 update-required) exit the process with code 1 through
 * the injected `exit` (spec §5.3/F); SIGINT/SIGTERM exit 0 — closing the socket cleanly
 * (1000) when one is attached, and aborting the backoff sleep within 250 ms when one is
 * not, so the first Ctrl-C always wins. Never resolves otherwise.
 *
 * Local liveness contract with `subshell status`: a `daemon.lock` ({pid, startedAt,
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
  const inventoryMs = deps.inventoryMs ?? INVENTORY_PERIOD_MS;
  const nowMs = deps.now ?? ((): number => Date.now());
  const wsUrl = resolveWsUrl(config); // persisted-at-enroll URL wins (ledger 17c)
  // The persisted debug flag, applied before the first frame is handled. The
  // environment still wins, and a machine with nothing stored stays at `info`.
  await loadAndApplyDebugLogging();

  // No plugin seeding, recovery, or refresh: the node holds no plugin concept
  // (inversion spec 2026-09-10 §6). A `<dataDir>/plugins/` directory left by a
  // pre-inversion agent is deliberately NOT deleted, NOT seeded, and NOT
  // refreshed — nothing in this binary reads that directory at all anymore
  // (the last reader, the `ready` env declarations, moved to the plane's
  // `detect` round trip), and nothing here may delete user data (spec §6: no
  // users, leave it on disk).
  const controlPublicKey = parsePinnedKey(config.controlPublicKey);

  // How this process runs (spec 2026-09-12 § 6.1), collected ONCE before the
  // connect loop: one `service status` spawn per process, not per reconnect,
  // and the answer cannot change while the pid does not. A failed read
  // degrades to null — the `ready` simply carries no `runtime`.
  const runtime = deps.runtime === undefined ? await collectRuntime().catch(() => null) : deps.runtime;

  // PER-PROCESS lifetimes (mixing these up is a security bug — see VerifyContext in node-signing):
  const jtiLru = new JtiLru(); // survives every reconnect: a replayed jti never gets a second evaluation
  const seqTracker = new SeqTracker(); // per-CONNECTION value; reset on every open below
  // jti → result cache: the `replay` verify path re-answers a double-delivered command
  // from here (and so does execute(), should the LRU ever evict inside the TTL window) —
  // a jti that has run once NEVER runs twice.
  const idempotent = new Map<string, CommandResult>();

  // PER-PROCESS executor context (spec §3.4/§7): built once, survives every
  // reconnect. `ws` is a STABLE wrapper routing to the CURRENT socket —
  // executors hold `ctx` across reconnects. The serial chain does NOT keep
  // the socket alive: a command verified on one socket can still be running
  // when it closes. What recovers from that is (a) `send`'s catch — a result
  // frame that can no longer leave is logged, never fatal, and (b) the
  // idempotence map: if the control plane re-delivers the same jti on the
  // NEW socket, the cached answer is re-sent without re-execution.
  let currentWs: WsLike | undefined;
  const commandWs: CommandWs = {
    send: (ev) => {
      if (!currentWs) {
        // The event had a real consumer (inventory/tail pumps never learn the
        // socket died mid-command) — one line so the void is at least visible.
        log(`dropped ${ev.type} event (no live socket)`);
        return;
      }
      send(currentWs, ev);
    },
    // Bun's WebSocket CLIENT does not surface bufferedAmount — read it
    // defensively (the tail pump, Task 5, throttles on it when present).
    get bufferedAmount() {
      return (currentWs as unknown as { bufferedAmount?: number } | undefined)?.bufferedAmount;
    },
  };
  const ctx: CommandContext = {
    config,
    tmux: deps.tmux ?? new TmuxRunner(),
    meta: deps.meta ?? new SubshellMetaStore(config.dataDir),
    nowMs,
    ws: commandWs,
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime,
    requestRestart: () => {
      // Deferred, because the daemon is the only sender of `result`: the
      // executor returns `{ ok: true }`, the frame leaves on this turn, and
      // the exit happens a macrotask later. A restart that never answered
      // would read as a timeout on the control plane rather than a success.
      //
      // The exit path is the signal handler's, verbatim: set `shuttingDown`,
      // close the socket cleanly, and let the loop's `if (shuttingDown)
      // stop(0)` do the rest. The service manager (`Restart=always` /
      // `KeepAlive`) is what brings the process back — which is why
      // `execRestart` refuses unless it is the manager's own pid.
      setTimeout(() => {
        if (shuttingDown) return;
        shuttingDown = true;
        log("restart requested by the control plane; exiting for the service manager to respawn");
        try {
          socket?.close(1000, "restart");
        } catch {
          /* already gone — the loop's pre-dial check exits 0 */
        }
      }, RESTART_EXIT_DELAY_MS);
    },
  };
  // Startup sweep for upload temps orphaned by a crash mid-stream (spec §3.4).
  // Never throws by contract — a broken sweep must not cost the node its connection.
  await cleanupStaleUploads(ctx);
  // SERIAL command executor (spec §3.4): verified commands queue here so pane
  // effects land in arrival order across the whole daemon life — surviving
  // reconnects. A command verified pre-`seqTracker.reset` executing post-reset
  // stays harmless: effects key by jti and the idempotence map spans reconnects.
  let execChain: Promise<void> = Promise.resolve();

  // Local-liveness lock for `subshell status` (fix wave 1). Best-effort: a home that
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
    log("signal received, closing the connection (graceful exit)");
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
      // stringify INSIDE the try: a hostile/unserializable payload would
      // otherwise throw past every guard and unwind the frame handler.
      const payload = JSON.stringify(ev);
      const size = Buffer.byteLength(payload); // exact UTF-8 size without allocating a Blob
      if (size > NODE_MAX_FRAME_BYTES) {
        // Mirrors the inbound rule: suppress, do NOT close — the control plane
        // already guards its own direction, so an oversize outbound frame is a
        // producer bug (log it loudly) rather than a reason to drop the link.
        log(`oversize ${ev.type} event suppressed (${size}B)`);
        return;
      }
      ws.send(payload);
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
    const result = await dispatchCommand(ctx, claims.cmd);
    idempotent.set(claims.jti, result);
    if (idempotent.size > IDEMPOTENCE_CAP) {
      const oldest = idempotent.keys().next().value as string | undefined;
      if (oldest !== undefined) idempotent.delete(oldest);
    }
    send(ws, { type: "result", ref: claims.jti, ...result });
  };

  /** One inbound frame: byte guard → jws extraction → verify → execute (spec §4). */
  const onFrame = async (ws: WsLike, data: unknown): Promise<void> => {
    if (typeof data !== "string") {
      log("ignored non-text frame");
      return;
    }
    const size = Buffer.byteLength(data); // exact UTF-8 size without allocating a Blob
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
        log("seq regression, dropping connection (spec §4)");
        try {
          ws.close(1000, "seq regression");
        } catch {
          /* already closing */
        }
      }
      return;
    }
    // SERIAL executor (spec §3.4): verify happened just now, but EXECUTION
    // queues behind every earlier verified command — arrival order across the
    // whole daemon life, never interleaved (a slow `launch` cannot let a
    // `write_file` slip past it). The chain's catch keeps a surprise throw
    // from poisoning the queue; `execute` itself swallows everything.
    execChain = execChain
      .then(() => execute(ws, outcome.claims))
      .catch((err: unknown) => log(`command execution failed: ${String(err)}`));
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
      currentWs = ws; // the ctx.ws seam routes executor events here while this connection lives
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let inventory: ReturnType<typeof setInterval> | undefined;
      let settled = false;
      const finish = (close: WsClose): void => {
        if (settled) return;
        settled = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (inventory !== undefined) clearInterval(inventory);
        if (socket === ws) socket = undefined;
        if (currentWs === ws) currentWs = undefined;
        // Tails push into the socket that just died — stop every pump before
        // the reconnect loop dials again (the control plane re-`tail_start`s
        // on the new connection with its own cursors; spec §3.4).
        stopAllTails(ctx);
        resolve(close);
      };
      ws.addEventListener("open", async () => {
        attempt = 0; // a successful open resets the backoff ladder
        log(`connected ${wsUrl} as node ${config.nodeId}`);
        // `ready` is built SYNCHRONOUSLY: nothing it reports needs a read
        // (identity is config + OS facts, `selfInvoke` is `selfInvokePrefix`,
        // and the env VALUES the resume paths need answer on the plane's
        // `detect` round trip, not here). So the send lands in the same
        // turn the open event fires — a socket cannot die mid-build because
        // there is no mid. (The census chain below and the ready send stay
        // LINEAR on purpose: `ready` before `subshells_report` before the
        // inventory push is pinned order.)
        send(ws, readyEvent(config, runtime));
        // Connect-time `subshells_report` (spec §3.3): re-projects the panes
        // that survived an agent restart so the control plane heals its rows.
        // Fire-and-forget with catch-log — a scan failure (junk meta, tmux
        // refusing) must never cost the connection.
        // One inventory-push body for both beats below (identical builder +
        // never-fatal posture; only the log label differs). The event is the
        // protocol-3 shape with no harness content (inversion §6, see
        // inventory.ts); the server's guard treats the empty claim as
        // "don't touch". The backend no longer PULLS the `inventory` command
        // at all — Task 7 retired the pull on `ready` (for a plugin-less
        // agent it round-tripped to nothing) and the re-check wave retired
        // the pull on Re-check with the same reasoning (R14c): the plane's
        // own `detect` command is what carries harness facts. The push stays
        // because the EVENT contract does; cheap enough that the old scan
        // memo has no job left.
        const pushInventory = (label: string): Promise<void> =>
          buildInventoryEvent(nowMs())
            .then((inv) => send(ws, inv))
            .catch((err: unknown) => log(`${label}: ${err instanceof Error ? err.message : String(err)}`));
        void buildSubshellsReport(ctx)
          .then((report) => send(ws, report))
          .catch((err: unknown) => log(`subshells_report failed: ${err instanceof Error ? err.message : String(err)}`))
          // Connect-time initial `inventory` push (spec §7 "inventory every 5 min
          // + on demand"; P3-T8b closed the missing first beat): the create-time
          // harness gate demands a FRESH snapshot, so without this a freshly
          // enrolled node was ONLINE yet 409'd every launch until a human hit
          // Re-check. ORDER IS LOAD-BEARING: the push chains AFTER the census
          // (success or failure) because the backend reconcile applies the
          // report's exits first. One push per connection — a reconnect
          // re-arms freshness, like the census.
          .then(() => pushInventory("inventory push failed"));
        heartbeat = setInterval(() => {
          send(ws, { type: "heartbeat", ts: new Date(nowMs()).toISOString() });
          writeLiveness(); // every heartbeat tick doubles as the local-liveness refresh
        }, heartbeatMs);
        // Periodic `inventory` push — the "every 5 min" leg of spec §7
        // (P3-T8c). The timer's lifecycle mirrors the heartbeat's — armed
        // here on open, cleared in finish() — so one push loop per connection
        // at most, and a reconnect re-arms freshness rather than stacking
        // loops.
        inventory = setInterval(() => {
          // TOTAL per tick (the exit-watcher posture, commands/report.ts): a
          // rejected scan must never become an unhandled rejection, and a
          // surprise throw must never kill the loop — every failure is
          // log-only, inside pushInventory.
          void pushInventory("periodic inventory push failed");
        }, inventoryMs);
        inventory.unref?.(); // a background push must never hold the daemon (or a test process) open
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
          `another subshell is already registered as node '${config.nodeId}' (close 4409); exiting, stop the duplicate agent first`,
        );
        stop(1);
      }
      if (close.code === NODE_CLOSE_UPDATE_REQUIRED) {
        log(updateRequiredMessage(close.reason));
        stop(1);
      }
      const delay = backoffDelay(attempt++, rand);
      log(
        `disconnected (code ${close.code}${close.reason ? `: ${close.reason}` : ""}); reconnecting in ${Math.round(delay)} ms`,
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
 * and is newest-wins, so probing while `subshell run` is live on this node
 * supersede-kicks the running agent (it treats 4409 as terminal). That is why
 * `subshell status` calls this ONLY on the explicit `--probe` opt-in (fix
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
      ws = new WebSocketImpl(resolveWsUrl(config), { headers: { Authorization: `Bearer ${config.nodeKey}` } });
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
