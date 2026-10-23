import { connect as netConnect } from "node:net";
import {
  type NodeEvent,
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_IDLE_MS,
  PREVIEW_LANE_BUFFER_MAX_BYTES,
  type PreviewCloseReason,
  type PreviewDataFrame,
} from "@internal/subshell-protocol";
import { log } from "../log.js";

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
 * there is no host on the wire (the grammar bounds the port, the dials are
 * loopback literals only), pane liveness is a command-time check, and the
 * node-side budget (Task 6 will widen it to a shared lane+bridge counter) is
 * read through {@link PreviewForward.laneCount}.
 */

/** The lane events this registry emits: the byte leg and the death notice. */
export type PreviewLaneEvent = Extract<NodeEvent, { type: "preview_data" | "preview_closed" }>;

/**
 * The dial target's socket, narrowed to what a lane uses — the seam lets a
 * test hand a fake that fires `connect`/`data`/`end`/`error` on demand, and
 * `net.Socket` satisfies it structurally.
 */
export interface LaneSocket {
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
  /** Defaults to the real `net.connect`; loopback literals only, whatever it dials. */
  connect?: (options: { host: string; port: number }) => LaneSocket;
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
  ref: string;
  port: number;
  paneId: string;
  lifetimeMs: number;
  hooks: LaneHooks;
  /** Per-lane seam overrides on top of the registry's own defaults. */
  deps?: LaneDeps;
}

interface Lane {
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
  /** Running total of bytes the pump refused to deliver (the slow-link budget). */
  pendingBytes: number;
  timers: { idle?: unknown; lifetime?: unknown };
  say: (line: string) => void;
}

/** The real dial: net's own connect, which the retry posture below wraps. */
const realConnect: NonNullable<LaneDeps["connect"]> = (options) => netConnect(options);

/** Real timers, unref'd: the watch-tick doctrine — a 15-minute idle arm must not hold the process open. */
const realTimers: LaneTimers = {
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
      log(`preview lane ${args.ref}: open for an already-registered ref, keeping the live lane`);
      return;
    }
    const now = args.deps?.now ?? this.defaults.now ?? Date.now;
    const lane: Lane = {
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
      pendingBytes: 0,
      timers: {},
      say: args.hooks.log ?? ((line: string) => log(line)),
    };
    this.lanes.set(lane.ref, lane);
    lane.say(
      `preview lane ${lane.ref}: opened for pane ${lane.paneId} at ${new Date(now()).toISOString()} (dialing port ${lane.port})`,
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
    lane.say(`preview lane ${ref}: closed by the plane (${reason})`);
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
      lane.socket?.write(Buffer.from(frame.blob, "base64"));
    } catch (err: unknown) {
      // The dialed target died under the write: the socket is gone, the lane
      // follows it. (The `error`/`end` handlers race this on a real socket;
      // the lane-presence guard makes first death win.)
      lane.say(`preview lane ${lane.ref}: inbound write failed (${String(err)}), closing target-gone`);
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
    const host = v6 ? "::1" : "127.0.0.1";
    let socket: LaneSocket;
    try {
      socket = lane.connect({ host, port: lane.port });
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
      lane.say(`preview lane ${lane.ref}: connected (${host}:${lane.port})`);
      this.touch(lane);
    });
    socket.on("data", (chunk) => {
      if (this.lanes.get(lane.ref) !== lane) return;
      this.onSocketData(lane, chunk);
    });
    // A real target EOF arrives as `end` then `close`; the lane-presence
    // guard in `die` collapses the pair into the single event spec §6 owes.
    socket.on("end", () => this.die(lane, "target-gone"));
    socket.on("close", () => this.die(lane, "target-gone"));
    socket.on("error", (err) => {
      if (this.lanes.get(lane.ref) !== lane) return;
      if (!up) this.dialFailed(lane, v6, err);
      // Post-connect failure is the target process dying mid-session.
      else this.die(lane, "target-gone");
    });
  }

  private dialFailed(lane: Lane, v6: boolean, err: unknown): void {
    if (this.lanes.get(lane.ref) !== lane) return;
    if (!v6) {
      // The one retry is not a second attempt at a different SERVICE — loopback
      // v4 and v6 are the same host, and a server bound to only one family is
      // routine. The lane's budget timers, not a dial timeout, bound the total.
      lane.say(`preview lane ${lane.ref}: 127.0.0.1:${lane.port} refused (${String(err)}), retrying ::1`);
      this.dial(lane, true);
      return;
    }
    this.die(lane, "target-gone");
  }

  /* ---------------------------------------------------------------- */
  /* the pump                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * One socket read heading plane-ward. The over-cap guard is the sender half
   * of spec §6's named close: the receiving parser refuses an over-cap blob
   * and the daemon drops what will not parse, so an unchecked sender would
   * corrupt the lane SILENTLY mid-stream. Net's 64 KiB chunks make this a
   * guard, not a routine. An over-cap read emits ZERO bytes and closes the
   * lane `over-cap` — never fragmentation.
   */
  private onSocketData(lane: Lane, chunk: Buffer): void {
    if (chunk.length > PREVIEW_FRAME_MAX_BYTES) {
      this.die(lane, "over-cap");
      return;
    }
    this.touch(lane);
    const frame = {
      type: "preview_data",
      ref: lane.ref,
      dir: "out",
      blob: chunk.toString("base64"),
    } as const;
    try {
      lane.hooks.emit(frame);
    } catch (err: unknown) {
      // Deliver-or-throw: the throw is the slow-link signal. The bytes join
      // the unaccepted total; the lane survives until that total passes the
      // budget (spec §5's number), then dies `slow-link`. Nothing re-sends
      // them — a lane with a dropped hole is already broken, and the budget
      // is what bounds how long "temporarily undeliverable" may pretend.
      lane.pendingBytes += chunk.length;
      if (lane.pendingBytes > lane.laneBufferMaxBytes) {
        lane.say(
          `preview lane ${lane.ref}: ${lane.pendingBytes}B undeliverable (budget ${lane.laneBufferMaxBytes}B), closing slow-link (${String(err)})`,
        );
        this.die(lane, "slow-link");
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
    lane.say(`preview lane ${lane.ref}: closing (${reason})`);
    try {
      lane.hooks.emit({ type: "preview_closed", ref: lane.ref, reason });
    } catch (err: unknown) {
      // Expected exactly once: the link-drop sweep closes lanes whose link is
      // already gone. The plane reads that link drop itself; the event is the
      // courtesy, and the agent log keeps the record.
      log(`preview lane ${lane.ref}: preview_closed (${reason}) undeliverable: ${String(err)}`);
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
