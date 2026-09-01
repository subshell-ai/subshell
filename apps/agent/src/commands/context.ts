import type { TmuxRunner } from "@internal/harnesses";
import type { JsonValue, NodeEvent } from "@internal/session-protocol";
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
 * Handle over one live `tail_start` pump (the real thing lands in Task 5's
 * tail.ts; the interface is pinned now so the context shape never moves).
 */
export interface TailHandle {
  /** Stops the pump and releases its watcher/timer. Must be idempotent. */
  stop(): void;
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
  /** Live log-tail pumps by subId (Task 5 fills this). */
  tails: Map<string, TailHandle>;
}

/**
 * One command's answer — the body of the `result` frame the daemon sends.
 * `data` must satisfy the per-command validator in
 * `@internal/session-protocol` `node-results.ts` when that command has one.
 */
export type CommandResult = { ok: true; data?: JsonValue } | { ok: false; error: string };
