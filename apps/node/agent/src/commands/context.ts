import type { TmuxRunner } from "@internal/pane-runtime";
import type {
  JsonValue,
  NodeCommandBody,
  NodeEvent,
  NodeMaintenanceWire,
  NodeRuntimeReport,
} from "@internal/subshell-protocol";
import type { NodeConfig } from "../config.js";
import type { ServiceDeps } from "../service.js";
import type { SubshellMetaStore } from "../subshell-meta.js";
import type { NodeBinaryDeps } from "../update.js";

/**
 * The command-executor seam (spec 2026-08-31 §7): everything an executor may
 * touch lives on {@link CommandContext}, and {@link CommandResult} is the only
 * thing a command answers with. The daemon owns the socket and the frame
 * sending; executors never write to a WebSocket directly — they return a
 * result and (for events like `inventory`) use `ctx.ws.send`.
 */

/**
 * Handle over one live `tail_start` pump (created by tail.ts). The subshell id
 * is part of the pinned shape so the exit watcher's death sweep (report.ts
 * `dropTailsFor`) can stop every sub belonging to a dead pane.
 */
export interface TailHandle {
  /** Stops the pump and releases its watcher/timer. Must be idempotent. */
  stop(): void;
  /** The subshell whose pane log this pump streams (death-sweep key). */
  readonly subshellId: string;
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
   * answer (`listSubshellsChecked` ok:false). An authoritative ok:true answer
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
  config: NodeConfig;
  /** The tmux runner all pane operations go through. */
  tmux: TmuxRunner;
  /** Per-subshell launch records (socket, cwd) — the policy's second root source. */
  meta: SubshellMetaStore;
  /** Epoch-ms clock (injectable; stamps inventory `ts` and friends). */
  nowMs: () => number;
  /**
   * How `update` resolves the binary it replaces (default: the real ladder).
   *
   * Injectable for the reason `nowMs` is, and with a sharper consequence: the
   * ladder asks the SERVICE DEFINITION first, which reads the real
   * launchd/systemd user domain. No temp directory hides that — `homedir()`
   * answers from the password database rather than `$HOME` — so without this
   * seam the update tests resolved the DEVELOPER's own installed agent instead
   * of their fixture, and the suite passed only on machines that do not run
   * Subshell (measured 2026-09-18).
   */
  binaryDeps?: NodeBinaryDeps;
  /** Outbound event seam (inventory events now; tail output/exit events later). */
  ws: CommandWs;
  /**
   * The panes supervised for natural death, keyed by subshellId →
   * {@link WatcherRegistration} (socket + registration token + unreachable
   * counter; filled by
   * launch/report.ts since Task 4; re-keyed from per-subshell timers to the
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
  /**
   * How this process runs (spec 2026-09-12 § 6.1), collected once at daemon
   * start; `null` when the report could not be built. `restart` refuses on
   * null — without the report there is no evidence that exiting would be a
   * restart rather than a stop.
   */
  runtime: NodeRuntimeReport | null;
  /**
   * The `{ on, changedAt }` this connection last told the plane about, or
   * undefined when it has said nothing (no mirror file at connect, or a
   * mirror it could not read).
   *
   * It exists so the machine reports CHANGES rather than state: a heartbeat
   * that re-sent the flag every 15 s would be a write on the plane every 15 s,
   * each one a candidate for reconciliation against the plane's own stamp.
   * Seeded from the same read that built `ready` — the frame has already said
   * this, so the first heartbeat must not say it again — and re-seeded on
   * every connect, since a new socket has told the plane nothing.
   *
   * `set_maintenance` sets it to what it wrote, which is what stops the node
   * from echoing the plane's own write back at it one tick later.
   */
  lastReportedMaintenance?: NodeMaintenanceWire;
  /**
   * Whether this connection has already reported a mirror it could not
   * rewrite (see `restoreMirrorFromMemo`).
   *
   * The restore is retried every tick — it costs one `writeFileSync` and
   * succeeds the moment the disk comes back — but the LINE is capped at one
   * per socket. At the 15 s heartbeat an ungated failure is four lines a
   * minute against the agent's 200 KB log, which replaces the file about six
   * times a day: on a machine that cannot write its own mirror, that discards
   * exactly the log an operator needs. Seeded with
   * {@link lastReportedMaintenance}, so a reconnect says it once more.
   */
  mirrorRestoreLogged?: boolean;
  /**
   * Ask the daemon to exit 0 AFTER the current result frame is sent. The
   * executor cannot exit itself: the daemon is the only sender of `result`,
   * and a restart that never answered would read as a timeout on the plane.
   */
  requestRestart: () => void;
  /**
   * The service manager seam the `service` command drives.
   *
   * Optional, and production omits it: `execService` builds the real
   * `DEFAULT_DEPS` when it is absent. It exists because every other seam in
   * `service.ts` is injected too — pinning the exact `systemctl`/`launchctl`
   * argv a verb runs is the only way to test them without a service manager,
   * and a test that installs a real launchd job is not a test anyone runs.
   */
  serviceDeps?: ServiceDeps;
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
