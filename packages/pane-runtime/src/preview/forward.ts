import { isIP, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { ServiceTarget } from "@internal/subshell-protocol";
import {
  type NodeEvent,
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_IDLE_MS,
  PREVIEW_LANE_BUFFER_MAX_BYTES,
  type PreviewCloseReason,
  type PreviewDataFrame,
} from "@internal/subshell-protocol";

/**
 * The node's forward lanes (pane-preview spec 2026-10-21 §4/§6, Task 5): the
 * ref→lane registry behind `preview_open`'s `forward` branch. A lane is the
 * machine's raw loopback TCP lane — the plane's same-origin proxy (Task 8)
 * dials into it through this daemon, and the pane's dev server answers as if
 * the browser were local.
 *
 * The A-branch contract is `ssh-relay-exec.ts`'s, copied for the reason it
 * earned there: the daemon's executor chain serializes every command, so the
 * dial runs OFF the chain. `openLane` registers the lane SYNCHRONOUSLY and
 * returns; the ack (`pending: true`) is the executor's, answered before the
 * socket has done anything. A dial that fails later is not a second answer to
 * the plane — it is one `preview_closed` `target-gone` event.
 *
 * Three things make a forward lane different from a relay session, and the
 * command's gate ladder owns all three, so nothing here re-decides them:
 * the grammar bounds the destination (loopback unless an explicit saved
 * HTTP(S) service is supplied), pane liveness is a command-time check, and the
 * node-side budget is the SHARED lane+bridge counter (Task 6): the open
 * executor sums the node-wide {@link PreviewForward.laneCount} with the
 * bridge registry's count before either mechanism starts, keeping the node to
 * {@link PREVIEW_SESSIONS_PER_NODE} of any mix.
 */

/**
 * The preview events the daemon's single sender carries: the lane's byte leg,
 * the bridge's screencast leg (widened here for Task 6: the sender is one
 * deliver-or-throw path, so slow-link accounting and link-drop behavior stay
 * true for both registries), and the death notice both share.
 */
export type PreviewLaneEvent = Extract<NodeEvent, { type: "preview_data" | "preview_closed" | "preview_stream" }>;

/**
 * The dial target's socket, narrowed to what a lane uses — the seam lets a
 * test hand a fake that fires `connect`/`data`/`end`/`error` on demand, and
 * `net.Socket` satisfies it structurally.
 */
export interface LaneSocket {
  /** Bytes Node has queued for a target that has not consumed its writes. */
  readonly writableLength: number;
  on(event: "connect", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  write(chunk: Buffer): unknown;
  destroy(): unknown;
}

/** The timer seam: same reason as the socket seam (fake the idle/lifetime clocks). */
export interface LaneTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The mechanics a caller (or a test) can replace. Production passes none. */
export interface LaneDeps {
  /** Defaults to TCP or certificate-verified TLS for an explicit HTTPS service. */
  connect?: (options: { host: string; port: number; protocol?: "http" | "https"; servername?: string }) => LaneSocket;
  now?: () => number;
  /** Defaults to global timers UNREF'd — a lane timer must never hold the daemon (or a test) open. */
  timer?: LaneTimers;
  /** Traffic-idle budget; defaults to {@link PREVIEW_IDLE_MS}. */
  idleMs?: number;
  /** Slow-link budget; defaults to {@link PREVIEW_LANE_BUFFER_MAX_BYTES}. */
  laneBufferMaxBytes?: number;
}

/** What a lane delivers through: the event sink and its line sink. */
export interface LaneHooks {
  /**
   * Hand one lane event to the CURRENT established link. DELIVER-OR-THROW —
   * the daemon wires the same pump the relay frames ride (`relay-send.ts`),
   * because the slow-link accounting READS the throw: a frame that did not
   * leave is unaccepted, and unaccepted bytes are the budget.
   */
  emit(ev: PreviewLaneEvent): void;
  /** Line sink for lane lifecycle (defaults to the agent log), the `RelayOpenSeams.log` habit. */
  log?: (line: string) => void;
}

/** One `openLane` call: everything the command's verified body carries. */
export interface OpenLaneArgs {
  service?: ServiceTarget;
  ref: string;
  port: number;
  paneId: string;
  lifetimeMs: number;
  hooks: LaneHooks;
  /** Per-lane seam overrides on top of the registry's own defaults. */
  deps?: LaneDeps;
}

interface Lane {
  service?: ServiceTarget;
  ref: string;
  paneId: string;
  port: number;
  lifetimeMs: number;
  hooks: LaneHooks;
  connect: NonNullable<LaneDeps["connect"]>;
  timer: LaneTimers;
  idleMs: number;
  laneBufferMaxBytes: number;
  /** Set the moment the dial starts (a pending socket is destroyed on death too). */
  socket?: LaneSocket;
  timers: { idle?: unknown; lifetime?: unknown };
  say: (line: string) => void;
}

/** The real dial: net's own connect, which the retry posture below wraps. */
const realConnect: NonNullable<LaneDeps["connect"]> = (options) =>
  options.protocol === "https"
    ? tlsConnect({
        host: options.host,
        port: options.port,
        servername: isIP(options.servername ?? options.host) ? undefined : (options.servername ?? options.host),
        rejectUnauthorized: true,
      })
    : netConnect(options);

/**
 * Real timers, unref'd: the watch-tick doctrine — a 15-minute idle arm must
 * not hold the process open. Exported because the CDP bridge (`cdp-bridge.ts`)
 * arms its handshake and lifetime budgets under the same rule.
 */
export const realTimers: LaneTimers = {
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    t.unref();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PreviewForward {
  private readonly lanes = new Map<string, Lane>();
  /** Registry-wide seam defaults (the daemon passes none; tests pass their fakes). */
  private readonly defaults: LaneDeps;

  constructor(deps: LaneDeps = {}) {
    this.defaults = deps;
  }

  /**
   * Register one lane SYNCHRONOUSLY and start its dial off the chain. Both
   * timers arm at open so a stuck dial still dies on budget. A ref the
   * registry already owns keeps the OLD lane (clobbering it would orphan a
   * live socket behind a second plane-side owner); crypto-random 32-hex refs
   * make that unrepresentable, and the plane's broker owns uniqueness.
   */
  openLane(args: OpenLaneArgs): void {
    if (this.lanes.has(args.ref)) {
      args.hooks.log?.(
        `preview lane ${args.ref.slice(0, 8)}…: open for an already-registered ref, keeping the live lane`,
      );
      return;
    }
    const now = args.deps?.now ?? this.defaults.now ?? Date.now;
    const lane: Lane = {
      service: args.service,
      ref: args.ref,
      paneId: args.paneId,
      port: args.port,
      lifetimeMs: args.lifetimeMs,
      hooks: args.hooks,
      connect: args.deps?.connect ?? this.defaults.connect ?? realConnect,
      timer: args.deps?.timer ?? this.defaults.timer ?? realTimers,
      idleMs: args.deps?.idleMs ?? this.defaults.idleMs ?? PREVIEW_IDLE_MS,
      laneBufferMaxBytes:
        args.deps?.laneBufferMaxBytes ?? this.defaults.laneBufferMaxBytes ?? PREVIEW_LANE_BUFFER_MAX_BYTES,
      socket: undefined,
      timers: {},
      say: args.hooks.log ?? (() => {}),
    };
    this.lanes.set(lane.ref, lane);
    lane.say(
      `preview lane ${lane.ref.slice(0, 8)}…: opened for pane ${lane.paneId} at ${new Date(now()).toISOString()} (dialing port ${lane.port})`,
    );
    this.arm(lane, "idle");
    this.arm(lane, "lifetime");
    this.dial(lane, false);
  }

  /**
   * Plane-ordered teardown. NOT access-gated (the caller's doctrine: a
   * switch-off mid-session must still be able to end a lane — teardown is not
   * a preview act) and silent by design: `preview_closed` is the node
   * volunteering a death the plane did not order, and the plane knows about
   * its own. A later socket death finds no lane, which is the suppression the
   * executor's tombstone answer (`closed: false`) describes.
   */
  closeLane(ref: string, reason: PreviewCloseReason): { closed: boolean } {
    const lane = this.lanes.get(ref);
    if (!lane) return { closed: false };
    this.remove(lane);
    lane.say(`preview lane ${ref.slice(0, 8)}…: closed by the plane (${reason})`);
    return { closed: true };
  }

  /**
   * One parsed inbound lane frame (the daemon's `preview_data` intake arm).
   * A ref with no lane is the ordinary race — a close landing before this
   * frame — and drops quietly, like the relay intake drops its own noise.
   */
  ingestInboundFrame(frame: PreviewDataFrame): void {
    const lane = this.lanes.get(frame.ref);
    if (!lane) return;
    // The plane's leg is `in` only; an `out` inbound is stream noise, and a
    // stranger blob is not this lane's bytes to write anywhere.
    if (frame.dir !== "in") return;
    this.touch(lane);
    try {
      // `socket` is set the moment the dial starts, so the only way to miss
      // it is a synchronous connect throw — and net buffers writes on a
      // connecting socket anyway.
      const bytes = Buffer.from(frame.blob, "base64");
      if (lane.socket && lane.socket.writableLength + bytes.byteLength > lane.laneBufferMaxBytes) {
        this.die(lane, "slow-link");
        return;
      }
      lane.socket?.write(bytes);
    } catch (err: unknown) {
      // The dialed target died under the write: the socket is gone, the lane
      // follows it. (The `error`/`end` handlers race this on a real socket;
      // the lane-presence guard makes first death win.)
      lane.say(`preview lane ${lane.ref.slice(0, 8)}…: inbound write failed (${String(err)}), closing target-gone`);
      this.die(lane, "target-gone");
    }
  }

  /** Lanes now registered, node-wide or for one pane — the command's budget read. */
  laneCount(paneId?: string): number {
    if (paneId === undefined) return this.lanes.size;
    let n = 0;
    for (const lane of this.lanes.values()) if (lane.paneId === paneId) n += 1;
    return n;
  }

  /**
   * The daemon's link-drop hook (and the revoked-switch sweep's forward half):
   * every lane dies with exactly one `preview_closed` each. The pump will
   * throw for each of these while the socket is gone — `die` treats that as
   * the expected answer (the plane reads the dropped link itself); what the
   * sweep guarantees is the machine-side state: no lane outlives the link it
   * served.
   */
  closeAll(reason: PreviewCloseReason): void {
    for (const lane of [...this.lanes.values()]) this.die(lane, reason);
  }

  /* ---------------------------------------------------------------- */
  /* dialing                                                           */
  /* ---------------------------------------------------------------- */

  /** Dial loopback v4 first; ONE v6 retry; both failures are `target-gone`. */
  private dial(lane: Lane, v6: boolean): void {
    const host = lane.service && lane.service.host !== "localhost" ? lane.service.host : v6 ? "::1" : "127.0.0.1";
    let socket: LaneSocket;
    try {
      socket = lane.connect({
        host,
        port: lane.port,
        ...(lane.service ? { protocol: lane.service.protocol, servername: lane.service.host } : {}),
      });
    } catch (err: unknown) {
      this.dialFailed(lane, v6, err);
      return;
    }
    lane.socket = socket;
    let up = false;
    socket.on("connect", () => {
      if (this.lanes.get(lane.ref) !== lane) {
        // The lane closed while this dial was in flight (link drop, plane
        // cut): this socket has no owner, so it must not keep the target's
        // half-open session alive behind the sweep.
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
        return;
      }
      up = true;
      lane.say(`preview lane ${lane.ref.slice(0, 8)}…: connected (${host}:${lane.port})`);
      this.touch(lane);
    });
    socket.on("data", (chunk) => {
      if (this.lanes.get(lane.ref) !== lane) return;
      this.onSocketData(lane, chunk);
    });
    // A failed connect's `error` is followed on a nextTick by a guaranteed
    // `close`, which can land after the retry has already taken `lane.socket`;
    // without the SOCKET-identity guard that late close reads as the lane
    // dying and kills the in-flight ::1 dial (Task 5 review, MAJOR-1). On a
    // live lane the real EOF pair (`end` then `close`) still collapses to one
    // event: `remove` destroys without clearing `lane.socket`, so the second
    // handler passes identity and dies inside `die`'s lane-presence guard.
    socket.on("end", () => {
      if (lane.socket === socket) this.die(lane, "target-gone");
    });
    socket.on("close", () => {
      if (lane.socket === socket) this.die(lane, "target-gone");
    });
    socket.on("error", (err) => {
      if (this.lanes.get(lane.ref) !== lane) return;
      if (!up) this.dialFailed(lane, v6, err);
      // Post-connect failure is the target process dying mid-session.
      else this.die(lane, "target-gone");
    });
  }

  private dialFailed(lane: Lane, v6: boolean, err: unknown): void {
    if (this.lanes.get(lane.ref) !== lane) return;
    if (!v6 && (!lane.service || lane.service.host === "localhost")) {
      // The one retry is not a second attempt at a different SERVICE — loopback
      // v4 and v6 are the same host, and a server bound to only one family is
      // routine. The lane's budget timers, not a dial timeout, bound the total.
      lane.say(`preview lane ${lane.ref.slice(0, 8)}…: 127.0.0.1:${lane.port} refused (${String(err)}), retrying ::1`);
      // Release the refused socket before the retry overwrites `lane.socket`:
      // its guaranteed `close` would otherwise find the lane live (the retry
      // is in flight) and `remove` would destroy the ::1 dial through the
      // stale reference (Task 5 review, MAJOR-1).
      try {
        lane.socket?.destroy();
      } catch {
        /* already gone */
      }
      this.dial(lane, true);
      return;
    }
    this.die(lane, "target-gone");
  }

  /* ---------------------------------------------------------------- */
  /* the pump                                                          */
  /* ---------------------------------------------------------------- */

  /** Split TCP reads into wire-sized frames without changing their byte order. */
  private onSocketData(lane: Lane, chunk: Buffer): void {
    this.touch(lane);
    // Bun can deliver reads larger than the protocol's frame limit. TCP read
    // boundaries aren't messages, so a large asset must not kill its lane.
    for (let offset = 0; offset < chunk.length; offset += PREVIEW_FRAME_MAX_BYTES) {
      if (this.lanes.get(lane.ref) !== lane) return;
      const frame = {
        type: "preview_data",
        ref: lane.ref,
        dir: "out",
        blob: chunk.subarray(offset, offset + PREVIEW_FRAME_MAX_BYTES).toString("base64"),
      } as const;
      try {
        lane.hooks.emit(frame);
      } catch (err: unknown) {
        // Keep the transport's queue budget: failed delivery ends this lane,
        // including the rest of this read, rather than skipping any bytes.
        lane.say(`preview lane ${lane.ref.slice(0, 8)}…: transport refused bytes, closing slow-link (${String(err)})`);
        this.die(lane, "slow-link");
        return;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Activity on EITHER leg re-arms the idle timer; connect counts as activity too. */
  private touch(lane: Lane): void {
    this.disarm(lane, "idle");
    this.arm(lane, "idle");
  }

  private arm(lane: Lane, which: "idle" | "lifetime"): void {
    // Both budgets die with the same word: the closed set has no lane-only
    // lifetime reason, and the plane's UI maps `idle` to "the lane stopped".
    lane.timers[which] = lane.timer.setTimeout(
      () => this.die(lane, "idle"),
      which === "idle" ? lane.idleMs : lane.lifetimeMs,
    );
  }

  private disarm(lane: Lane, which: "idle" | "lifetime"): void {
    const handle = lane.timers[which];
    if (handle !== undefined) {
      lane.timer.clearTimeout(handle);
      lane.timers[which] = undefined;
    }
  }

  /** The ONE death path: deregister, disarm, destroy, then exactly one event. */
  private die(lane: Lane, reason: PreviewCloseReason): void {
    if (this.lanes.get(lane.ref) !== lane) return;
    this.remove(lane);
    lane.say(`preview lane ${lane.ref.slice(0, 8)}…: closing (${reason})`);
    try {
      lane.hooks.emit({ type: "preview_closed", ref: lane.ref, reason });
    } catch (err: unknown) {
      // Expected exactly once: the link-drop sweep closes lanes whose link is
      // already gone. The plane reads that link drop itself; the event is the
      // courtesy, and the agent log keeps the record.
      lane.say(`preview lane ${lane.ref.slice(0, 8)}…: preview_closed (${reason}) undeliverable: ${String(err)}`);
    }
  }

  /** Deregister first, then release the lane's holds (timers, socket). */
  private remove(lane: Lane): void {
    this.lanes.delete(lane.ref);
    this.disarm(lane, "idle");
    this.disarm(lane, "lifetime");
    try {
      lane.socket?.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * The daemon's live registry, published so the SHARED node budget (spec §6's
 * "16 per node" over lanes AND bridges, Task 6) can be read from anywhere
 * without threading the instance. `daemon.ts` owns this lifecycle like
 * `relaySessions`: set at boot, cleared when the loop unwinds; no active
 * registry answers 0, which is the honest "nothing is open here".
 */
let activeForward: PreviewForward | undefined;

/** Publish (or clear) the daemon's registry as the node-wide count source. @internal test seams may set it. */
export function setActivePreviewForward(registry: PreviewForward | undefined): void {
  activeForward = registry;
}

/**
 * Open lanes node-wide, through the active registry. The open executor reads
 * the lane half straight off its own context registry; this is the same
 * number for callers that hold no instance.
 */
export function forwardCount(): number {
  return activeForward?.laneCount() ?? 0;
}
