import type { TmuxRunner } from "@internal/harnesses";
import type { JsonValue, NodeCommandBody, NodeEvent } from "@internal/session-protocol";
import type { AgentConfig } from "../config.js";
import type { SessionMetaStore } from "../session-meta.js";

/**
 * The command-executor seam (spec 2026-08-31 §7): everything an executor may
 * touch lives on {@link CommandContext}, and {@link CommandResult} is the only
 * thing a command answers with. The daemon owns the socket and the frame
 * sending; executors never write to a WebSocket directly — they return a
 * result and (for events like `inventory`) use `ctx.ws.send`.
 */

/**
 * Handle over one live `tail_start` pump (created by tail.ts). The session id
 * is part of the pinned shape so the exit watcher's death sweep (report.ts
 * `dropTailsFor`) can stop every sub belonging to a dead pane.
 */
export interface TailHandle {
  /** Stops the pump and releases its watcher/timer. Must be idempotent. */
  stop(): void;
  /** The mote session whose pane log this pump streams (death-sweep key). */
  readonly sessionId: string;
}

/** The websocket surface an executor may use: emit events; optionally read backpressure. */
export interface CommandWs {
  /** Send one outbound event on the CURRENT connection (the daemon routes + guards). */
  send(ev: NodeEvent): void;
  /**
   * Bytes queued in the socket's write buffer, when the implementation
   * surfaces one (Bun's WebSocket client does not — hence optional; the tail
   * pump treats `undefined` as "no backpressure signal").
   */
  readonly bufferedAmount?: number;
}

/**
 * One in-flight `write_file` stream (spec §3.4), keyed in
 * {@link CommandContext.uploads} by the RESOLVED final path. The chunk
 * receiver owns this state entirely; it never touches the socket.
 */
export interface UploadState {
  /** Absolute path of the `.<basename>.part` temp living beside the final path. */
  tmpPath: string;
  /** Running byte total across accepted chunks — echoed as `received` on every answer. */
  received: number;
  /** Next chunk index this stream accepts (order gate; a mismatch is refused). */
  expectedChunk: number;
}

/** Everything `dispatchCommand` (index.ts) hands an executor. */
export interface CommandContext {
  /** The enrolled config — `dataDir` is the root of the path policy (spec §7). */
  config: AgentConfig;
  /** The tmux runner all pane operations go through. */
  tmux: TmuxRunner;
  /** Per-session launch records (socket, cwd) — the policy's second root source. */
  meta: SessionMetaStore;
  /** Epoch-ms clock (injectable; stamps inventory `ts` and friends). */
  nowMs: () => number;
  /** Outbound event seam (inventory events now; tail output/exit events later). */
  ws: CommandWs;
  /** Live pane-exit watcher intervals by sessionId (filled by launch/report.ts since Task 4). */
  watchers: Map<string, ReturnType<typeof setInterval>>;
  /** Live log-tail pumps by subId (filled by tail.ts; drained by `stopAllTails` on socket close). */
  tails: Map<string, TailHandle>;
  /** In-flight `write_file` streams by resolved final path (filled by write-file.ts; survives reconnects). */
  uploads: Map<string, UploadState>;
}

/**
 * One command's answer — the body of the `result` frame the daemon sends.
 * `data` must satisfy the per-command validator in
 * `@internal/session-protocol` `node-results.ts` when that command has one.
 */
export type CommandResult = { ok: true; data?: JsonValue } | { ok: false; error: string };

/**
 * Narrowing alias for one command's executor signature — the ONE declaration
 * shared by the executor modules (basics/launch/prompt/tail).
 */
export type Cmd<T extends NodeCommandBody["type"]> = Extract<NodeCommandBody, { type: T }>;
