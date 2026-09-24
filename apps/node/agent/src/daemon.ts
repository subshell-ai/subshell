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
  type NodeMaintenanceWire,
  type NodeRuntimeReport,
  SeqTracker,
  verifyCommand,
} from "@internal/subshell-protocol";
import { backoffDelay } from "./backoff.js";
import type { CommandContext, CommandResult, CommandWs } from "./commands/context.js";
import { dispatchCommand } from "./commands/index.js";
import { buildSubshellsReport, maybeReportMaintenance, seedMaintenanceMemo } from "./commands/report.js";
import { stopAllTails } from "./commands/tail.js";
import { cleanupStaleUploads } from "./commands/write-file.js";
import { loadConfig, type NodeConfig, updateConfig } from "./config.js";
import { registerRestart, setDaemonState } from "./dashboard/state.js";
import { loadAndApplyDebugLogging } from "./debug-logging.js";
import { mapOs } from "./enroll.js";
import { reportHomeDir } from "./host-env.js";
import { buildInventoryEvent } from "./inventory.js";
import { binaryPayload, createLinkNegotiator, type LinkNegotiator, type LinkNegotiatorArgs } from "./link-crypto.js";
import { clearLock, writeLock } from "./lock.js";
import { log } from "./log.js";
import { createRetentionPass, PANE_LOG_RETENTION_PASS_MS, resolveLogRetention } from "./pane-log-retention.js";
import { noteSweepScheduled } from "./retention-settings.js";
import { collectRuntime } from "./runtime.js";
import { selfInvokePrefix } from "./self-invoke.js";
import { SubshellMetaStore } from "./subshell-meta.js";
import { completeUpdate, revertAfterRefusal } from "./update.js";
import { NODE_VERSION } from "./version.js";

/**
 * `subshell run` — the signed-frame execution loop (spec 2026-08-31 §7).
 *
 * Since spec 2026-09-24 the socket opens ENCRYPTED: `link-crypto.ts` runs the
 * kx/binding handshake (or §5's register self-heal) before this loop sends or
 * interprets a single frame, `ready` and everything after it rides the sealed
 * stream, and a 4410 handshake refusal is an ordinary (retried) disconnect —
 * NOT added to the terminal close-code list below.
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
 * How long an open socket with nothing on it counts as the plane ACCEPTING a
 * freshly installed binary (spec 2026-09-15 §5.1).
 *
 * **The spec said 30 seconds and that is wrong, because §5.3 changed what an
 * open socket means.** Its reasoning was that a refusal is immediate, so a
 * socket still open after 30 s has passed the gates. That was true when a
 * refused agent was CLOSED. It is not true now: a refused agent is HELD — the
 * socket stays open indefinitely and the 4406 arrives only after the plane's
 * ten-minute idle budget. At 30 s the two rules together delete `.previous`
 * on exactly the machine that is about to need it, and the rollback ten
 * minutes later finds nothing to restore.
 *
 * So the number is above the plane's `HELD_IDLE_MS`, and it must stay above
 * it: the only thing that separates "accepted and quiet" from "held" is which
 * of the two events lands first.
 *
 * In practice the timer is a belt and never the buckle. The plane pushes
 * `set_allowed_dirs` on EVERY accepted `ready`
 * (`services/nodes/allowed-dirs-sync.ts`, unconditional — an empty list is a
 * real push), so an accepted agent receives a frame within milliseconds and
 * settles the transaction there. What the timer covers is a plane that stops
 * doing that; the cost of it never firing is a stale ~70 MB `.previous` until
 * the next update overwrites it, against the cost of it firing too early,
 * which is the rollback.
 */
export const UPDATE_ACCEPTED_MS = 15 * 60 * 1000;

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
  /**
   * Send one frame: the JSON text the daemon emits today, and — once an
   * encrypted link exists (spec 2026-09-24, task 9 seals the outbound path) —
   * the binary ciphertext of the secretstream. Bun's client accepts both.
   */
  send(data: string | Uint8Array): void;
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
  /** Pane-log retention pass period, ms (default {@link PANE_LOG_RETENTION_PASS_MS}). */
  retentionMs?: number;
  /**
   * The pane-log retention pass (default: {@link sweepExpiredPaneLogs} bound
   * to this node's data dir, meta store and tmux runner).
   * @internal test seam — production never passes one.
   */
  retentionPass?: () => Promise<unknown>;
  /**
   * The per-socket link negotiator factory (default `createLinkNegotiator`).
   * @internal test seam — the daemon tests drive the REAL negotiator against a
   * handshake-capable fake plane; this seam exists so the wiring, not the
   * crypto, is what `runConnection` depends on. There is deliberately no
   * "plaintext mode": spec §6 forbids a v14 socket ever running unsealed.
   */
  link?: (args: LinkNegotiatorArgs) => LinkNegotiator;
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
function resolveWsUrl(config: NodeConfig): string {
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

function readyEvent(
  config: NodeConfig,
  runtime: NodeRuntimeReport | null,
  maintenance: NodeMaintenanceWire | undefined,
): Extract<NodeEvent, { type: "ready" }> {
  return {
    type: "ready",
    agentVersion: NODE_VERSION,
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
    // This machine's maintenance mirror (spec 2026-09-14 §4.3). OMITTED, never
    // null-valued, when there is no file to report: absence means "this node
    // has no stamp of its own", which is what lets the plane's row win
    // outright instead of tying with a value nobody wrote. An UNREADABLE file
    // is carried, as the `on` it produces under its own mtime — it refuses
    // every launch here, and a plane told nothing about that has no row to
    // reconcile and no reason to push the clean file that repairs it.
    ...(maintenance ? { maintenance } : {}),
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
export async function runDaemon(config: NodeConfig, deps: DaemonDeps = {}): Promise<never> {
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
  // Publish the daemon's live facts to the local dashboard and hand it the
  // ONE restart path this process has (spec 2026-09-19). Before the first
  // dial: a dashboard served by this process must be able to answer the
  // plane-socket questions while the plane is simply down, and `restart`
  // through anything but `ctx.requestRestart` would exit with result frames
  // still unsent. Cleared in the finally below so a test seam that unwinds
  // the loop cannot leave a dead closure registered.
  setDaemonState({ serverUrl: config.serverUrl, nodeId: config.nodeId, runtime });
  registerRestart(() => ctx.requestRestart());
  // Startup sweep for upload temps orphaned by a crash mid-stream (spec §3.4).
  // Never throws by contract — a broken sweep must not cost the node its connection.
  await cleanupStaleUploads(ctx);

  // Pane-log retention (2026-09-23): the node ages out its own transcripts.
  // The plane's hourly sweep never reaches this disk, and the only node-side
  // deletion before this was `remove_paths` AT DELETE TIME — so an offline
  // node kept typed transcripts indefinitely. Boot resolves env > config.json
  // > 1 day, with `0 + 0` the keep-forever pair; an unusable env spelling is
  // a warn line and the next layer, never a failed start. Boot pass + hourly
  // after it, LOCAL by construction: it does not wait for the plane and keeps
  // running while the plane is unreachable — the offline window is exactly
  // when a missed delete used to persist.
  //
  // The boot resolution decides the SCHEDULE (forever schedules nothing, the
  // documented skip); the pass itself RE-RESOLVES the stored layer from
  // `config.json` every run, which is the live-effect half of the dashboard's
  // setter (R3): with a pass scheduled, a window written while this daemon
  // runs lands on the next hourly sweep without a restart. The honest
  // boundary is the other boot shape: a node that booted keep-forever armed no
  // timer, so LEAVING forever waits for the restart that arms one. Which
  // shape this is cannot be read off disk (round-3 review, finding 5) — the
  // memo below is how the retention endpoints tell the card, whose copy must
  // promise only what a scheduled pass can deliver.
  const retention = resolveLogRetention(process.env, config);
  noteSweepScheduled(!retention.forever);
  for (const problem of retention.problems) log(`pane log retention: ${problem}`);
  const retentionPass =
    deps.retentionPass ??
    createRetentionPass({
      boot: config,
      meta: ctx.meta,
      tmux: ctx.tmux,
      readCurrent: () => loadConfig(),
      onReadError: (message) => log(message),
    });
  if (!retention.forever) {
    const logSweepFailure = (err: unknown): void => {
      log(`pane log retention pass failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    // Fire-and-forget, scheduled before the first dial but NOT awaited
    // (round-3 review, finding 2): the census is one tmux probe per meta
    // record, and on a wedged host that is minutes of tmux timeouts — paid
    // serially, an AWAITED boot pass stalled the node's first connection for
    // the sweep's entire wall-time. A transcript one hourly beat late is a
    // bounded cost; a node that cannot answer its plane at all is not. What
    // the boot pass could not finish (its census slow, its dir locked), the
    // next tick re-attempts with fresh state — the pass is total and its own
    // swallow-and-log posture already covers the missed case.
    void retentionPass().catch(logSweepFailure);
    // Unref'd: the socket and heartbeat keep the process alive, a sweep must
    // not be what holds one open (and must not hold a test process, whose
    // daemon unwinds through the injected `exit` rather than the process).
    const retentionTimer = setInterval(() => {
      void retentionPass().catch(logSweepFailure);
    }, deps.retentionMs ?? PANE_LOG_RETENTION_PASS_MS);
    retentionTimer.unref?.();
  }
  // SERIAL command executor (spec §3.4): verified commands queue here so pane
  // effects land in arrival order across the whole daemon life — surviving
  // reconnects. A command verified pre-`seqTracker.reset` executing post-reset
  // stays harmless: effects key by jti and the idempotence map spans reconnects.
  let execChain: Promise<void> = Promise.resolve();
  // The INPUT fast path (spec 2026-09-21 Wave A): input commands stop queuing
  // behind the main chain, which a dashboard's preview captures can occupy for
  // hundreds of milliseconds, and typed keys were waiting on those. Inputs run
  // on their own chain, in arrival order among themselves, CONCURRENTLY with
  // the main chain; captures, probes, launches and resize keep the main chain
  // and its order untouched. PER-DAEMON, like `execChain`, and deliberately
  // not per-socket: the chain ORDERS a retry's EXECUTION behind the old
  // socket's in-flight write, so the pane takes the keystrokes in arrival
  // order even when the retry races. It does NOT make the retry idempotent:
  // the plane's dedupe window consults on ARRIVAL and commits only writes
  // that have already LANDED, so a retry racing an in-flight write can still
  // write twice (at-least-once, never zero). See the residual ambiguity in
  // the plane's ws/subshell-ws.ts. What the chain still buys is the ordering
  // half: even a duplicated keystroke arrives adjacent to its own first
  // write, never interleaved behind a later one.
  let inputChain: Promise<void> = Promise.resolve();

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
  /**
   * The CURRENT connection's link negotiator (spec 2026-09-24). Like
   * {@link currentWs} it routes to whatever socket is live: a command that
   * finishes while a fresh socket is still handshaking has its result frame
   * dropped with a log rather than leaked as plaintext on a v14 socket — the
   * idempotence map re-answers it when the plane re-delivers after
   * establishment, exactly as a send into a dead socket always did.
   */
  let link: LinkNegotiator | undefined;
  /**
   * The §5 register's write path, settled (spec 2026-09-24). The PLANE closes
   * a register socket right after `register-ok` (ruling R7), and that close
   * resolves the loop's `runConnection` a microtask before `updateConfig`
   * lands — an ungated redial would read the still-unprovisioned live config
   * and register a SECOND time. Measured in task 9's test before the gate
   * existed: connect, provisioned-close, register, register-ok… the loop only
   * settling once the async write finally raced ahead. This promise is what
   * the dial awaits between connections; a failed store resolves it too (the
   * negotiator refused and logged; the retry starts clean).
   */
  let provisioning: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  /**
   * Has this process already settled the update transaction, either way?
   *
   * PER-PROCESS, not per-connection: the transaction belongs to the binary
   * that booted, and a reconnect is not a second chance to decide it. The flag
   * is also what keeps `completeUpdate` — a file read — off the reconnect path
   * of a long-lived daemon that was never updated at all.
   */
  let updateSettled = false;
  /**
   * The plane accepted this binary (see {@link UPDATE_ACCEPTED_MS}): finish
   * the transaction by dropping `<binary>.previous` and the marker.
   *
   * Fire-and-forget with a catch-log, like every other best-effort disk touch
   * in this loop: leaving a stale `.previous` behind costs ~70 MB and nothing
   * else, and it must never cost the connection.
   */
  const markUpdateAccepted = (): void => {
    if (updateSettled) return;
    updateSettled = true;
    void completeUpdate(config.dataDir).catch((err: unknown) => {
      log(`could not clear the update marker: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
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
      // The stale-socket guard FIRST, and the order is load-bearing: a command
      // that resolves after its socket died (the per-connection chain is not
      // awaited by `finish`) must NOT reach `sealFrame` at all — sealing
      // advances the CURRENT link's ratchet, the bytes die on the dead socket,
      // and every later frame on the healthy new link fails its open (§6:
      // never resync). Pre-encryption a stale send just vanished; the
      // encryption is what makes silence destructive. (Round-1 review finding.)
      if (ws !== currentWs) {
        log(`dropped ${ev.type} event (stale socket — its link is gone)`);
        return;
      }
      // Spec 2026-09-24 §6: an established link carries ONLY ciphertext, and a
      // v14 socket has no plaintext event path at all — every event producer in
      // this daemon is armed by `onEstablished`, so reaching the drop branch
      // below means a send raced a reconnect (logged, never fatal: the plane
      // re-delivers by jti, which the idempotence map answers without
      // re-execution). The Buffer-view wrap is the `binaryPayload` idiom: a raw
      // Uint8Array can get text-framed by the send path it meets.
      const session = link?.established() ? link.session() : undefined;
      if (!session) {
        log(`dropped ${ev.type} event (${link ? "link not established" : "no link yet"})`);
        return;
      }
      ws.send(binaryPayload(session.sealFrame(payload)));
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

  /**
   * The byte guards, run ON ARRIVAL rather than in the serialization chain
   * below.
   *
   * They are synchronous and cost nothing, and putting them behind the chain
   * would mean a burst of oversize frames is RETAINED in a queue before being
   * rejected — the daemon holding megabytes of hostile noise it has already
   * decided to drop. Dropped here, the memory goes with the event.
   *
   * The SAME cap measures both shapes natively (spec 2026-09-24 ruling R2's
   * agent-side twin): bytes by their length, text by its UTF-8 size — never
   * by a re-serialization of one into the other.
   *
   * @param data - the raw `message` payload
   * @returns `{ text }` or `{ bytes }` (every binary shape normalized to a
   *   Uint8Array view — Bun's client delivers a Buffer, and the WebAPI
   *   spelling is an ArrayBuffer), or null when the frame was logged and
   *   dropped
   */
  const admitFrame = (data: unknown): { text: string } | { bytes: Uint8Array } | null => {
    const oversize = (size: number): null => {
      // Ignore, do NOT close: the server already guards its own direction, so
      // an oversize inbound frame is hostile noise — answer nothing.
      log(`oversize frame ignored (${size} bytes > ${NODE_MAX_FRAME_BYTES})`);
      return null;
    };
    if (typeof data === "string") {
      const size = Buffer.byteLength(data); // exact UTF-8 size without allocating a Blob
      return size > NODE_MAX_FRAME_BYTES ? oversize(size) : { text: data };
    }
    if (data instanceof ArrayBuffer) {
      return data.byteLength > NODE_MAX_FRAME_BYTES ? oversize(data.byteLength) : { bytes: new Uint8Array(data) };
    }
    if (data instanceof Uint8Array) {
      // Covers Buffer too (Buffer extends Uint8Array); `.length` is the
      // view's own byte span, not a backing store it may share.
      return data.length > NODE_MAX_FRAME_BYTES ? oversize(data.length) : { bytes: data };
    }
    log("ignored non-text frame");
    return null;
  };

  /** One ADMITTED frame: jws extraction → verify → execute (spec §4). */
  const onFrame = async (ws: WsLike, data: string): Promise<void> => {
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
    // THE TRANSACTION SETTLES HERE, on a VERIFIED command that is not
    // `update` — not on "any inbound frame", which is where it used to be and
    // which is false for exactly the case it matters in.
    //
    // A held socket (spec §5.3) is a plane that REFUSED this binary, and the
    // one thing it sends such a node is the `update` command that rescues it.
    // Settling on that frame dropped `<binary>.previous` and the marker before
    // the rescue had run, so a rescue that then failed — a 401 from a token
    // the plane forgot across its own restart is the commonest cause, but a
    // digest mismatch or an unwritable directory do it too — left the machine
    // on the incompatible binary with nothing to roll back to. `revertAfterRefusal`
    // finds no marker at the 4406 ten minutes later, and someone walks to the
    // machine.
    //
    // A verified NON-update command still proves what the old check was
    // reaching for: this plane is talking TO this binary, not about to refuse
    // it. An accepted node that is simply sent nothing settles on
    // `UPDATE_ACCEPTED_MS` instead, which is the belt that already exists and
    // is deliberately longer than the plane's hold budget.
    if (outcome.claims.cmd.type !== "update") markUpdateAccepted();

    // SERIAL executor (spec §3.4): verify happened just now, but EXECUTION
    // queues behind every earlier verified command — arrival order across the
    // whole daemon life, never interleaved (a slow `launch` cannot let a
    // `write_file` slip past it). The chain's catch keeps a surprise throw
    // from poisoning the queue; `execute` itself swallows everything.
    // `input` alone takes the fast path above: it joins its own chain instead,
    // which is what stops a keystroke from waiting out a capture ahead of it.
    // Everything else, resize included (rare, and read-your-writes adjacent),
    // keeps the main chain.
    if (outcome.claims.cmd.type === "input") {
      inputChain = inputChain
        .then(() => execute(ws, outcome.claims))
        .catch((err: unknown) => log(`command execution failed: ${String(err)}`));
      return;
    }
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
      let acceptedTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (close: WsClose): void => {
        if (settled) return;
        settled = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (inventory !== undefined) clearInterval(inventory);
        if (acceptedTimer !== undefined) clearTimeout(acceptedTimer);
        if (socket === ws) socket = undefined;
        if (currentWs === ws) currentWs = undefined;
        if (link === connLink) link = undefined; // send() falls to the logged drop, never to a stale seal key
        setDaemonState({ connected: false });
        // Tails push into the socket that just died — stop every pump before
        // the reconnect loop dials again (the control plane re-`tail_start`s
        // on the new connection with its own cursors; spec §3.4).
        stopAllTails(ctx);
        resolve(close);
      };
      // The per-socket link negotiator (spec 2026-09-24). It owns the wire
      // until the ack opens: kx + sealed binding on a provisioned config,
      // §5's register on a legacy one. Its frames BYPASS `frameChain` and
      // never consume a `seq` — they are not commands. `persist` writes the
      // register flow's keys through `updateConfig` (the merge discipline
      // every writer of the node key's only home goes through) and mirrors
      // the patch onto the LIVE config object — that write-back is what makes
      // the provisioning close's redial come up in handshake mode instead of
      // registering forever off a stale snapshot.
      function persistLink(patch: Partial<NodeConfig>): Promise<void> {
        const write = updateConfig(patch).then((next) => {
          for (const key of Object.keys(patch) as (keyof NodeConfig)[]) {
            (config as unknown as Record<string, unknown>)[key] = (next as unknown as Record<string, unknown>)[key];
          }
        });
        // Gate the redial on the write (see {@link provisioning}): a FAILED store
        // settles the gate quietly too — the negotiator's own persist catch
        // refuses and logs; the gate only needs to be settled, not successful.
        provisioning = write.then(
          () => undefined,
          () => undefined,
        );
        return write; // the negotiator must see a rejection to refuse on it
      }
      const connLink = (deps.link ?? createLinkNegotiator)({
        config,
        log,
        persist: persistLink,
        onEstablished: () => arm(),
      });
      link = connLink;
      ws.addEventListener("open", () => {
        attempt = 0; // a successful open resets the backoff ladder
        log(`connected ${wsUrl} as node ${config.nodeId}`);
        setDaemonState({ connected: true });
        // The handshake is this connection's first turn (ruling R6: no server
        // reply is awaited — derivation happens against the PINNED control key
        // and kx + binding go out back-to-back). The catch is a belt: begin
        // swallows its own failures into a refusal close, and a surprise throw
        // must never become an unhandled rejection.
        void connLink.begin(ws).catch((err: unknown) => {
          log(`link begin failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      /**
       * Everything the OLD open listener did directly, moved here: an agent
       * that never established must send no `ready`, heartbeat nothing, and
       * arm no update timer (spec 2026-09-24: handshake first, protocol
       * after). Fires exactly once per socket, synchronously inside the
       * message turn that opened the sealed ack.
       */
      function arm(): void {
        // `ready` is built SYNCHRONOUSLY: nothing it reports needs a read
        // (identity is config + OS facts, `selfInvoke` is `selfInvokePrefix`,
        // and the env VALUES the resume paths need answer on the plane's
        // `detect` round trip, not here). So the send lands in the same turn
        // the sealed ack opened — a socket cannot die mid-build because there
        // is no mid. (The census chain below and the ready send stay LINEAR on
        // purpose: `ready` before `subshells_report` before the inventory push
        // is pinned order.)
        // The mirror is read SYNCHRONOUSLY too, and by the seeder itself: the
        // value `ready` carries and the memo that stops the first heartbeat
        // repeating it are one read, so they cannot disagree.
        send(ws, readyEvent(config, runtime, seedMaintenanceMemo(ctx)));
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
          const tickAt = new Date(nowMs()).toISOString();
          send(ws, { type: "heartbeat", ts: tickAt });
          setDaemonState({ connected: true, lastHeartbeatAt: tickAt });
          writeLiveness(); // every heartbeat tick doubles as the local-liveness refresh
          // The BELT for a maintenance flip (spec 2026-09-14 §4.3). The other
          // report path rides the deaths a flip causes, which reports nothing
          // when the machine had no panes running — the commonest case for
          // `subshell maintenance off`, where there is nothing to die at all.
          maybeReportMaintenance(ctx);
        }, heartbeatMs);
        // Periodic `inventory` push — the "every 5 min" leg of spec §7
        // (P3-T8c). The timer's lifecycle mirrors the heartbeat's — armed
        // here on establishment, cleared in finish() — so one push loop per
        // connection at most, and a reconnect re-arms freshness rather than
        // stacking loops.
        inventory = setInterval(() => {
          // TOTAL per tick (the exit-watcher posture, commands/report.ts): a
          // rejected scan must never become an unhandled rejection, and a
          // surprise throw must never kill the loop — every failure is
          // log-only, inside pushInventory.
          void pushInventory("periodic inventory push failed");
        }, inventoryMs);
        inventory.unref?.(); // a background push must never hold the daemon (or a test process) open
        // The quiet half of "the plane accepted this binary" — a belt under
        // the verified-command check in `onFrame`, and deliberately LONGER
        // than the plane's hold budget, since an open socket no longer proves
        // acceptance on its own. See UPDATE_ACCEPTED_MS.
        acceptedTimer = setTimeout(markUpdateAccepted, UPDATE_ACCEPTED_MS);
        acceptedTimer.unref?.();
      }
      // SERIAL FRAME HANDLER, and the serialization is not a nicety.
      //
      // `verifyCommand` awaits an ES256 `crypto.subtle.verify` BEFORE it
      // reaches the seq gate, and the gate refuses any seq <= the last
      // accepted. So a handler that started each message's verify immediately
      // let concurrent frames reach that gate in whatever order the crypto
      // happened to finish — and the first time a higher seq landed first, the
      // one behind it was called a REGRESSION and the connection was dropped
      // (spec §4). Measured on this machine: three concurrent verifies land
      // out of order in 19 of 20 rounds.
      //
      // What that cost in practice is a paste, or fast typing, on a node:
      // several `input` frames in one event-loop turn took down every subshell
      // on that machine until the reconnect. `TmuxRunner`'s per-pane input
      // chain cannot help — the damage happens before anything is enqueued.
      //
      // The chain is PER CONNECTION, matching `seqTracker`'s own lifetime (it
      // is reset on every open), and a frame's handling starts only once the
      // previous frame's has finished. The catch is on the chain rather than
      // on each call, so one rejected frame is logged and the next still runs.
      //
      // The two cheap byte guards run BEFORE the chain (see `admitFrame`), so
      // a frame the daemon has already decided to drop is never retained
      // waiting for its turn.
      // The negotiator owns EVERY frame from this socket (task 9's rule, the
      // mirror of the server's machine): text before establishment is handshake
      // material or a 4410 refusal, and bytes are opened here — the command
      // loop below only ever sees DECRYPTED envelopes. A plaintext command that
      // somehow reached an established link never gets a `verify: malformed`
      // answer; it gets a 4410 close instead (spec §6). The handshake frames the
      // negotiator itself emits never join `frameChain` and never consume a
      // `seq` — they are not commands.
      let frameChain: Promise<void> = Promise.resolve();
      ws.addEventListener("message", (ev) => {
        const frame = admitFrame(ev.data);
        if (frame === null) return;
        if ("bytes" in frame) {
          const plaintext = connLink.onBytesFrame(ws, frame.bytes);
          if (plaintext === null) return; // consumed (the ack), dropped (no stream), or refused (dead stream)
          frameChain = frameChain
            .then(() => onFrame(ws, plaintext))
            .catch((err: unknown) => log(`frame handling error: ${String(err)}`));
          return;
        }
        connLink.onTextFrame(ws, frame.text);
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
      await provisioning; // §5: R7's provisioning close must not redial past its own key write
      const close = await runConnection();
      if (shuttingDown) stop(0); // graceful: the socket closed cleanly on our request
      if (close.code === NODE_CLOSE_SUPERSEDED) {
        log(
          `another subshell is already registered as node '${config.nodeId}' (close 4409); exiting, stop the duplicate agent first`,
        );
        stop(1);
      }
      if (close.code === NODE_CLOSE_UPDATE_REQUIRED) {
        // THE NODE'S WHOLE ROLLBACK (spec 2026-09-15 §5.2 step 5). A plane
        // that refuses a binary this machine installed seconds ago has said
        // the only thing that matters — that version cannot talk to it — so
        // `<binary>.previous` goes back and the exit below hands the manager
        // the version that worked. Without a pending marker this does nothing
        // and the log line beneath is the behaviour this code always had: a
        // plane refusing an agent nobody just updated is the ordinary "your
        // node is too old" case, and swapping files there would be inventing
        // a rollback for an update that never happened.
        updateSettled = true;
        const reverted = await revertAfterRefusal(config.dataDir, close.reason || "the control plane refused it").catch(
          (err: unknown) => {
            log(`could not roll the update back: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          },
        );
        log(updateRequiredMessage(close.reason));
        if (reverted) {
          log(`restored subshell ${reverted.from}; the service manager will bring it back`);
        }
        stop(1);
      }
      const delay = backoffDelay(attempt++, rand);
      log(
        `disconnected (code ${close.code}${close.reason ? `: ${close.reason}` : ""}); reconnecting in ${Math.round(delay)} ms`,
      );
      await sleepCancellable(delay);
    }
  } finally {
    registerRestart(null);
    setDaemonState({ connected: false });
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
export function probeOnline(config: NodeConfig, deps: OnlineProbeDeps = {}): Promise<boolean> {
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
