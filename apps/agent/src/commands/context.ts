import type { TmuxRunner } from "@internal/harnesses";
import type { JsonValue, NodeCommandBody, NodeEvent } from "@internal/subshell-protocol";
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
  /** The subshell session whose pane log this pump streams (death-sweep key). */
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

/**
 * One entry in {@link CommandContext.watchers}: the socket the shared tick
 * probes, plus the identity of THIS registration. A relaunch of the same id
 * (auto-restart on the same row) re-arms with a fresh token, so a tick that
 * snapshotted the old pane can tell "still mine" from "a newer registration
 * owns this id now" and never clobber the live relaunch.
 */
export interface WatcherRegistration {
  /** The tmux socket the pane was created on (from the launch wire — `cmd.socket`). */
  socket: string;
  /**
   * Unique identity of this registration; every `startExitWatcher` call mints
   * a new `Symbol()`. The exit tick guards ownership on the registration
   * OBJECT reference — this symbol is the explicit handle for callers/tests.
   */
  token: symbol;
  /**
   * Consecutive ticks on which this registration's socket probe FAILED to
   * answer (`listSessionsChecked` ok:false). An authoritative ok:true answer
   * resets it; the threshold that finally reports death is
   * `NODE_EXIT_UNREACHABLE_TICKS` in report.ts (design 2026-09-02 §1 — a live
   * pane must not die from one tmux blip). A relaunch mints a fresh
   * registration, hence a fresh budget: a replaced entry counts from 0.
   */
  unreachable: number;
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
  /**
   * The panes supervised for natural death, keyed by sessionId →
   * {@link WatcherRegistration} (socket + registration token + unreachable
   * counter; filled by
   * launch/report.ts since Task 4; re-keyed from per-session timers to the
   * shared-tick set by the exit-watcher batching — ONE interval now ticks for
   * every entry, probing each distinct socket once per tick). Re-arming the
   * same id (a relaunch on a restarted row) REPLACES the entry with a fresh
   * token, and the tick's forget/drop tail only runs while its snapshotted
   * registration is still the map's current one — a relaunch mid-forget keeps
   * its meta record and tail pumps. `stopWatcher` removes one entry.
   */
  watchers: Map<string, WatcherRegistration>;
  /**
   * The ONE shared exit-watcher interval, live while `watchers` is non-empty
   * and cleared (set to undefined) the moment it drains. Unref'd — it must
   * never hold the daemon (or a test process) open. report.ts owns its
   * lifecycle; nothing else may touch it.
   */
  watchTick?: ReturnType<typeof setInterval>;
  /** Live log-tail pumps by subId (filled by tail.ts; drained by `stopAllTails` on socket close). */
  tails: Map<string, TailHandle>;
  /** In-flight `write_file` streams by resolved final path (filled by write-file.ts; survives reconnects). */
  uploads: Map<string, UploadState>;
}

/**
 * One command's answer — the body of the `result` frame the daemon sends.
 * `data` must satisfy the per-command validator in
 * `@internal/subshell-protocol` `node-results.ts` when that command has one.
 */
export type CommandResult = { ok: true; data?: JsonValue } | { ok: false; error: string };

/**
 * Narrowing alias for one command's executor signature — the ONE declaration
 * shared by the executor modules (basics/launch/prompt/tail).
 */
export type Cmd<T extends NodeCommandBody["type"]> = Extract<NodeCommandBody, { type: T }>;
