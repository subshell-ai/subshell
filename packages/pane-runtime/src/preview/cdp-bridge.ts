import {
  type NodeEvent,
  PREVIEW_FRAME_MAX_BYTES,
  PREVIEW_WATCH_FPS_MAX,
  PREVIEW_WATCH_FPS_MIN,
  PREVIEW_WATCH_FRAMES_BUFFERED,
  PREVIEW_WATCH_JPEG_QUALITY,
  type PreviewCloseReason,
  previewDimensionsAllowed,
} from "@internal/subshell-protocol";
import { CDP_LOOPBACK_FAMILIES, fetchCdpJson } from "./cdp-http.js";
import { type LaneTimers, realTimers } from "./forward.js";

/**
 * The node's CDP watch bridge (pane-preview spec 2026-10-21 §5, Task 6): the
 * ref→bridge registry behind `preview_open`'s `screencast` branch. A bridge
 * dials the pane's Chrome DevTools port on loopback, starts a JPEG
 * screencast, and turns `Page.screencastFrame` notifications into
 * `preview_stream` events for the plane's fan-out.
 *
 * Three contracts hold this module together, and each earned its shape:
 *
 * - **The ack is unconditional.** Every capture gets its
 *   `Page.screencastFrameAck` the moment it arrives, whatever the emitter
 *   later does with it. An unacked frame makes Chrome stop painting the
 *   screencast, so backpressure here may only ever cost bytes, never the
 *   capture pipeline.
 * - **The rate reduction sits at the emit boundary** (decision 8, a recorded
 *   deviation from spec §4's pacing at the reduction SITE): capture every
 *   repaint with `everyNthFrame: 1` and drop the extras against
 *   `clampFps(fps)` here rather than sizing the CDP pacing formula there. One
 *   pin-able clamp replaces an untested formula, and a dropped frame costs no
 *   base64 and no plane-to-node bytes.
 * - **Drop, never backpressure.** While `emitStream` is behind, the bridge
 *   holds at most {@link PREVIEW_WATCH_FRAMES_BUFFERED} frames and drops the
 *   rest; an over-cap blob is dropped too (the plane's parser refuses one, so
 *   an emitting bridge would corrupt the stream silently). And there is NO
 *   traffic-based self-close: a static page repaints nothing and must keep
 *   its watch. The spec's 60 s idle is zero-SUBSCRIBER idle, which is
 *   plane-side refcount state this process cannot see. Self-close is only
 *   lifetime expiry (`idle`) and target death (`target-gone`).
 *
 * The bridge dials loopback only and distrusts what it reads: the port came
 * from the /proc walk (Task 4), but the `webSocketDebuggerUrl` is answered by
 * a socket on that port, so a non-loopback host inside it is refused
 * `not-cdp`, never followed.
 */

/** One screencast frame on its way to the plane. */
export type PreviewStreamEvent = Extract<NodeEvent, { type: "preview_stream" }>;
/** The bridge's own death notice, the same event the lanes volunteer. */
export type PreviewClosedEvent = Extract<NodeEvent, { type: "preview_closed" }>;

/** The handshake covers `/json/list` plus the websocket reaching open; this is its whole budget. */
export const BRIDGE_HANDSHAKE_BUDGET_MS = 3000;

/** The `http://127.0.0.1:<port>/json/list` answer, narrowed to what a bridge reads. */
interface BridgeFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** One CDP target row; anything else in the array is a stranger's JSON and ignored. */
interface CdpTarget {
  type?: unknown;
  webSocketDebuggerUrl?: unknown;
}

/**
 * The websocket seam. Production reaches the global `WebSocket` (bun ships
 * one; no dependency); the seam exists so the handshake-budget case can hand
 * a socket that never opens.
 */
export interface BridgeWs {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((err: unknown) => void) | null;
  onclose: (() => void) | null;
  onmessage: ((msg: { data: string | Buffer }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** The mechanics a caller (or a test) can replace. Production passes none. */
export interface BridgeDeps {
  /** Defaults to the global `fetch`. */
  fetch?: (url: string) => Promise<BridgeFetchResponse>;
  /** Defaults to the global `WebSocket`. */
  WebSocketImpl?: new (
    url: string,
  ) => BridgeWs;
  /** Defaults to `Date.now` (stamps `ts` and drives the fps throttle). */
  now?: () => number;
  /** Defaults to the daemon's unref'd timers (same handle `forward.ts` uses). */
  timer?: LaneTimers;
}

/** What one `preview_open` screencast arm hands the bridge. */
export interface StartBridgeArgs {
  ref: string;
  /** The devtools port the plane's discovery attributed to the pane, dialed on loopback only. */
  cdpPort: number;
  /** Already defaulted by the branch when the command omitted it; the bridge still clamps. */
  fps: number;
  lifetimeMs: number;
  /**
   * Hand one stream frame to the CURRENT established link. DELIVER-OR-THROW
   * (the same sender the lanes ride): a throw is a frame that did not leave,
   * and the bridge's answer is to drop it and keep capturing (the link-drop
   * sweep in `daemon.ts` ends the bridges when the link itself dies). A
   * returned promise means the pump is behind: the queue holds until it
   * settles, which is what the buffer cap counts.
   */
  emitStream: (ev: PreviewStreamEvent) => undefined | Promise<unknown>;
  /** The same sender, for the death notice. */
  emitClosed: (ev: PreviewClosedEvent) => void;
  deps?: BridgeDeps;
  /** Line sink for bridge lifecycle (defaults to the agent log), the `RelayOpenSeams.log` habit. */
  log?: (line: string) => void;
}

interface Bridge {
  ref: string;
  ws?: BridgeWs;
  /** Monotonic per ref; assigned when a frame passes every drop gate and is built. */
  seq: number;
  /** The bridge's clock: the `now` seam default (`Date.now`), stamped as `ts`. */
  now: () => number;
  intervalMs: number;
  /** Last accepted emission's stamp; `-Infinity` means "first frame always emits". */
  lastEmitAt: number;
  /** Frames built but not yet accepted by `emitStream` (capped, drained in order). */
  queue: PreviewStreamEvent[];
  draining: boolean;
  timer: LaneTimers;
  lifetime?: unknown;
  emitStream: StartBridgeArgs["emitStream"];
  emitClosed: StartBridgeArgs["emitClosed"];
  say: (line: string) => void;
  /** CDP message ids: CDP only needs them distinct per session, and incrementing is distinct. */
  nextId: number;
}

/** The live bridge registry, module-level like the daemon's other per-machine maps. */
const bridges = new Map<string, Bridge>();

/**
 * Handshakes in flight, keyed by ref. A bridge joins {@link bridges} only
 * once its handshake lands, which would leave a screencast open invisible to
 * {@link bridgeCloseAll} for the budget window, exactly the hazard the
 * link-drop sweep exists to close. Every start registers HERE first, so the
 * sweep can cancel it: `cancel` rejects the awaiting `startBridge` and marks
 * the handshake settled, and a late open then closes its socket instead of
 * registering.
 */
interface PendingHandshake {
  bridge: Bridge;
  cancel: (reason: string) => void;
}
const pending = new Map<string, PendingHandshake>();

/** Clamp the command's fps into the protocol's [1, 5] window (pure; exported for its pin). */
export function clampFps(fps: number): number {
  return Math.min(PREVIEW_WATCH_FPS_MAX, Math.max(PREVIEW_WATCH_FPS_MIN, fps));
}

/** Bridges now registered: the shared node budget's bridge half (the lane half is the registry's `laneCount()`). */
export function bridgeCount(): number {
  return bridges.size + pending.size;
}

/**
 * Start one screencast: fetch `/json/list`, pick the newest page target,
 * distrust its websocket URL (loopback or refuse), open the socket, and start
 * the capture. Resolves `{ subscribers: 1 }` when the screencast is running;
 * EVERY handshake failure (non-200, no target, non-loopback URL, dead or hung
 * socket, expired budget) rejects with a `not-cdp` Error and leaves no
 * half-started state behind. The fps default lives in the branch that reads
 * the command, not here; the clamp lives here.
 */
export async function startBridge(args: StartBridgeArgs): Promise<{ subscribers: number }> {
  if (bridges.has(args.ref)) {
    // Same posture as `openLane`: a ref the registry owns keeps its live
    // bridge, and crypto-random 32-hex refs make the collision unrepresentable.
    args.log?.(`preview bridge ${args.ref.slice(0, 8)}…: open for an already-registered ref, keeping the live bridge`);
    return { subscribers: 1 };
  }
  const now = args.deps?.now ?? Date.now;
  const timer = args.deps?.timer ?? realTimers;
  const discovery = new AbortController();
  const fetchImpl: NonNullable<BridgeDeps["fetch"]> =
    args.deps?.fetch ??
    (async (url) => {
      const data = await fetchCdpJson(url, discovery.signal);
      return { ok: true, status: 200, json: async () => data };
    });
  // The one seam cast: the DOM `WebSocket` libtype does not describe the
  // narrower surface a bridge uses, and the production default is the global.
  const WSImpl: NonNullable<BridgeDeps["WebSocketImpl"]> =
    args.deps?.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => BridgeWs);
  const say = args.log ?? (() => {});

  const bridge: Bridge = {
    ref: args.ref,
    seq: 0,
    now,
    intervalMs: Math.ceil(1000 / clampFps(args.fps)),
    lastEmitAt: -Infinity,
    queue: [],
    draining: false,
    timer,
    emitStream: args.emitStream,
    emitClosed: args.emitClosed,
    say,
    nextId: 1,
  };
  say(
    `preview bridge ${bridge.ref.slice(0, 8)}…: starting against 127.0.0.1:${args.cdpPort} ` +
      `(fps ${clampFps(args.fps)}, interval ${bridge.intervalMs} ms, lifetime ${args.lifetimeMs} ms)`,
  );

  let budgetHandle: unknown;
  let settled = false;
  let ws: BridgeWs | undefined;
  let handshakeOpen: () => void = () => {};
  let handshakeFail: (why: string) => void = () => {};
  let handshakeCancel: (reason: string) => void = () => {};
  // Drop only OUR pending entry: a second handshake under the same ref (an
  // unrepresentable collision, but this map is global) must not be orphaned
  // by the first one settling.
  const clearPending = (): void => {
    if (pending.get(args.ref)?.bridge === bridge) pending.delete(args.ref);
  };
  const handshake = new Promise<{ subscribers: number }>((resolve, reject) => {
    handshakeOpen = () => {
      if (settled) return;
      settled = true;
      clearPending();
      discovery.abort();
      timer.clearTimeout(budgetHandle);
      bridges.set(bridge.ref, bridge);
      // The lifetime arms only once the mechanism is actually running: the
      // handshake budget owns the phase before this, and it never double-fires
      // because the promise above has exactly one winner.
      bridge.lifetime = timer.setTimeout(() => die(bridge, "idle"), args.lifetimeMs);
      resolve({ subscribers: 1 });
    };
    handshakeFail = (why: string) => {
      if (settled) return;
      settled = true;
      clearPending();
      discovery.abort();
      timer.clearTimeout(budgetHandle);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      say(`preview bridge ${bridge.ref.slice(0, 8)}…: handshake failed (${why}), refusing not-cdp`);
      reject(new Error("not-cdp"));
    };
    handshakeCancel = (reason: string) => {
      if (settled) return; // the budget or a failure already owned this handshake
      settled = true;
      clearPending();
      discovery.abort();
      timer.clearTimeout(budgetHandle);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      // NO `preview_closed` is volunteered: the plane never held this ref. The
      // awaiting open simply answers a refusal, and the open arm speaks
      // `not-cdp` whatever the handshake throws, so the message only carries
      // the sweep's reason for the log.
      say(`preview bridge ${bridge.ref.slice(0, 8)}…: handshake cancelled by the link-drop sweep (${reason})`);
      reject(new Error(reason));
    };
  });
  pending.set(args.ref, { bridge, cancel: handshakeCancel });
  budgetHandle = timer.setTimeout(
    () => handshakeFail(`handshake budget ${BRIDGE_HANDSHAKE_BUDGET_MS} ms expired`),
    BRIDGE_HANDSHAKE_BUDGET_MS,
  );

  // The socket's ongoing handlers are wired BEFORE the handshake resolves so a
  // frame or a death racing the open lands on the bridge that owns them.
  const attachSocket = (url: string): void => {
    try {
      ws = new WSImpl(url);
    } catch (err: unknown) {
      handshakeFail(`websocket dial threw (${String(err)})`);
      return;
    }
    bridge.ws = ws; // the frame path acks through the bridge, not just the closure
    ws.onopen = () => {
      if (settled) {
        // The handshake was cancelled by the sweep (or the budget fired)
        // while this open was in flight: the socket has no owner, so close
        // it instead of starting a screencast nobody registered for.
        try {
          ws?.close();
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        ws?.send(JSON.stringify({ id: bridge.nextId++, method: "Page.enable" }));
        ws?.send(
          JSON.stringify({
            id: bridge.nextId++,
            method: "Page.startScreencast",
            params: { format: "jpeg", quality: PREVIEW_WATCH_JPEG_QUALITY, everyNthFrame: 1 },
          }),
        );
      } catch (err: unknown) {
        handshakeFail(`screencast start threw (${String(err)})`);
        return;
      }
      handshakeOpen();
    };
    ws.onerror = (err) => {
      // On an unregistered bridge this is the handshake dying; on a live one
      // the paired `close` that follows is the one death path (the die-guard
      // makes first death win either way).
      if (!bridges.has(bridge.ref)) handshakeFail(`websocket error (${String(err)})`);
      else die(bridge, "target-gone");
    };
    ws.onclose = () => {
      if (!bridges.has(bridge.ref)) handshakeFail("websocket closed before open");
      else die(bridge, "target-gone");
    };
    ws.onmessage = (msg) => {
      if (bridges.get(bridge.ref) !== bridge) return;
      onSocketMessage(bridge, msg.data);
    };
  };

  // Step 1: the target list. Non-200, a throw, junk JSON, or no usable target
  // are all "this port is not answering CDP", which is what `not-cdp` names.
  // Both loopback spellings get asked, in the lane's order, because a browser
  // bound to `::1` only is routine and discovery now lists such a port: the
  // bridge that refuses to ask it would call a watchable browser `not-cdp`.
  void (async () => {
    let response: BridgeFetchResponse | null = null;
    let refusal: string | null = null;
    for (const host of CDP_LOOPBACK_FAMILIES) {
      try {
        const candidate = await fetchImpl(`http://${host}:${args.cdpPort}/json/list`);
        if (candidate.ok) {
          response = candidate;
          break;
        }
        refusal = `list answered ${candidate.status}`;
      } catch (err: unknown) {
        refusal = `list fetch threw (${String(err)})`;
      }
    }
    if (!response) {
      handshakeFail(refusal ?? "list found no loopback answer");
      return;
    }
    let targets: unknown;
    try {
      targets = await response.json();
    } catch (err: unknown) {
      handshakeFail(`list JSON was junk (${String(err)})`);
      return;
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      handshakeFail("list carried no targets");
      return;
    }
    // Newest first per CDP's own ordering; a page target wins, else the first
    // row stands (a worker-only list still means this port answers CDP).
    const rows = targets as CdpTarget[];
    const target = rows.find((t) => t.type === "page") ?? rows[0];
    const url = typeof target?.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : "";
    if (!url) {
      handshakeFail("the chosen target carries no webSocketDebuggerUrl");
      return;
    }
    // The URL is answered by a socket on a port that came from /proc:
    // distrust it. WHATWG parses a v6 host bracketed, so compare the parsed
    // hostname with the brackets gone; the constraint names `::1`, and this
    // check must not silently narrow it.
    let destination: URL;
    try {
      destination = new URL(url);
    } catch {
      handshakeFail("webSocketDebuggerUrl is not a URL");
      return;
    }
    const host = destination.hostname.replace(/^\[|\]$/g, "");
    if (
      (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") ||
      (destination.protocol !== "ws:" && destination.protocol !== "wss:") ||
      Number(destination.port || (destination.protocol === "wss:" ? 443 : 80)) !== args.cdpPort ||
      destination.username ||
      destination.password ||
      destination.hash
    ) {
      handshakeFail("webSocketDebuggerUrl must stay on the requested loopback port without credentials or a fragment");
      return;
    }
    // Resolve the loopback alias ourselves; the target cannot choose a DNS lookup.
    if (host === "localhost") destination.hostname = "127.0.0.1";
    if (settled) return;
    attachSocket(destination.href);
  })();

  return handshake;
}

/**
 * Plane-ordered teardown. NOT access-gated (the `preview_close` doctrine:
 * teardown is not a preview act) and silent by design: the plane ordered this
 * death. False when the ref is not a bridge, which is what lets the close
 * executor fall through to the tombstone answer.
 */
export function stopBridge(ref: string, reason: PreviewCloseReason): boolean {
  const starting = pending.get(ref);
  if (starting) {
    starting.cancel(reason);
    return true;
  }
  const bridge = bridges.get(ref);
  if (!bridge) return false;
  remove(bridge);
  bridge.say(`preview bridge ${ref.slice(0, 8)}…: closed by the plane (${reason})`);
  return true;
}

/**
 * The daemon's link-drop hook beside the lanes': every bridge dies with
 * exactly one `preview_closed`, and every IN-FLIGHT HANDSHAKE is cancelled
 * (see the {@link pending} note) so a late open can never register behind a
 * dead link. Without either, a continuous-repaint page would screencast
 * forever after the plane's link died. The pump throws for each of these (the
 * link is gone); `die` treats that as the expected answer, and a cancelled
 * handshake volunteers nothing: the plane never held that ref.
 */
export function bridgeCloseAll(reason: PreviewCloseReason): void {
  for (const entry of [...pending.values()]) entry.cancel(reason);
  for (const bridge of [...bridges.values()]) die(bridge, reason);
}

/* ------------------------------------------------------------------ */
/* the frame path                                                      */
/* ------------------------------------------------------------------ */

/**
 * One CDP notification in: ack it IMMEDIATELY and always (an unacked capture
 * stalls the browser's screencast), then run the drop gates - size, throttle,
 * queue cap - and only then build and queue the event. Dropped frames cost
 * nothing else: the bridge stays alive for the next one.
 */
function onSocketMessage(bridge: Bridge, raw: string | Buffer): void {
  // Bound work before JSON parsing or base64 decoding, including malformed input.
  if (Buffer.byteLength(raw) > Math.ceil(PREVIEW_FRAME_MAX_BYTES / 3) * 4 + 64 * 1024) return;
  let msg: { method?: unknown; params?: { data?: unknown; metadata?: unknown; sessionId?: unknown } };
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as typeof msg;
  } catch {
    return; // stream noise, not a CDP object: nothing to ack or emit
  }
  if (msg?.method !== "Page.screencastFrame") return; // command results and other events are not frames
  const params = msg.params ?? {};
  const sessionId = params.sessionId;
  if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId < 0) return;
  try {
    bridge.ws?.send(JSON.stringify({ id: bridge.nextId++, method: "Page.screencastFrameAck", params: { sessionId } }));
  } catch (err: unknown) {
    // The socket died between delivery and ack; the `close` handler is the
    // death path, and this bridge is already on its way out.
    bridge.say(`preview bridge ${bridge.ref.slice(0, 8)}…: ack send failed (${String(err)})`);
  }
  const blob = typeof params.data === "string" ? params.data : "";
  if (blob.length === 0 || Buffer.from(blob, "base64").length > PREVIEW_FRAME_MAX_BYTES) {
    // The plane's parser refuses an over-cap blob, so emitting one would
    // corrupt the lane SILENTLY. Drop it; the bridge continues.
    bridge.say(
      `preview bridge ${bridge.ref.slice(0, 8)}…: frame over the ${PREVIEW_FRAME_MAX_BYTES}B cap (or empty), dropped`,
    );
    return;
  }
  const meta = (params.metadata ?? {}) as { deviceWidth?: unknown; deviceHeight?: unknown };
  const w = meta.deviceWidth;
  const h = meta.deviceHeight;
  if (!previewDimensionsAllowed(w, h)) {
    bridge.say(`preview bridge ${bridge.ref.slice(0, 8)}…: frame dimensions outside the preview budget, dropped`);
    return;
  }
  // Throttle: `Math.ceil(1000 / fps)` between emissions, extras dropped (the
  // decision-8 reduction site). `-Infinity` starts the series so the first
  // capture always emits.
  const stamp = bridge.now();
  if (stamp - bridge.lastEmitAt < bridge.intervalMs) return;
  bridge.lastEmitAt = stamp;
  // Queue cap: what the bridge HOLDS, not what the wire promises. A stalled
  // pump may hold at most `PREVIEW_WATCH_FRAMES_BUFFERED`; past that, drop.
  if (bridge.queue.length >= PREVIEW_WATCH_FRAMES_BUFFERED) {
    bridge.say(
      `preview bridge ${bridge.ref.slice(0, 8)}…: ${bridge.queue.length} frames already held, dropped one (the pump is behind)`,
    );
    return;
  }
  bridge.seq += 1;
  bridge.queue.push({
    type: "preview_stream",
    ref: bridge.ref,
    seq: bridge.seq,
    w: w as number,
    h: h as number,
    ts: stamp,
    blob,
  });
  void drain(bridge);
}

/**
 * Push the queue at the pump in order. A synchronous `emitStream` (production)
 * drains everything in this turn; a returned promise means the pump is behind
 * and the queue holds (and caps) until it settles. A throw is an undeliverable
 * frame: dropped and logged, never re-sent - a stream with a hole stays a
 * stream with a hole, and the link-drop sweep is the real remedy for a dead
 * link.
 */
async function drain(bridge: Bridge): Promise<void> {
  if (bridge.draining) return;
  bridge.draining = true;
  while (bridge.queue.length > 0) {
    const ev = bridge.queue[0];
    try {
      const accepted = bridge.emitStream(ev);
      if (accepted && typeof accepted.then === "function") await accepted;
    } catch (err: unknown) {
      bridge.say(`preview bridge ${bridge.ref.slice(0, 8)}…: stream frame undeliverable, dropped (${String(err)})`);
    }
    bridge.queue.shift();
    if (bridges.get(bridge.ref) !== bridge) break; // closed mid-drain: stop feeding a dead bridge
  }
  bridge.draining = false;
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** The ONE death path: deregister, disarm, close, then exactly one event. */
function die(bridge: Bridge, reason: PreviewCloseReason): void {
  if (bridges.get(bridge.ref) !== bridge) return;
  remove(bridge);
  bridge.say(`preview bridge ${bridge.ref.slice(0, 8)}…: closing (${reason})`);
  try {
    bridge.emitClosed({ type: "preview_closed", ref: bridge.ref, reason });
  } catch (err: unknown) {
    // Expected exactly once: the link-drop sweep closes bridges whose link is
    // already gone. The plane reads that link drop itself; the agent log keeps
    // the record.
    bridge.say(`preview bridge ${bridge.ref.slice(0, 8)}…: preview_closed (${reason}) undeliverable: ${String(err)}`);
  }
}

/** Deregister first, then release the bridge's holds (timer, socket, queue). */
function remove(bridge: Bridge): void {
  bridges.delete(bridge.ref);
  if (bridge.lifetime !== undefined) {
    bridge.timer.clearTimeout(bridge.lifetime);
    bridge.lifetime = undefined;
  }
  bridge.queue.length = 0;
  try {
    bridge.ws?.close();
  } catch {
    /* already gone */
  }
}
