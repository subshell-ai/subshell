import {
  type JsonValue,
  PREVIEW_FORWARD_SESSIONS_PER_PANE,
  PREVIEW_SESSIONS_PER_NODE,
  PREVIEW_WATCH_FPS_DEFAULT,
} from "@internal/subshell-protocol";
import { type BridgeDeps, bridgeCount, startBridge } from "../preview/cdp-bridge.js";
import { getPreviewEnabled, getVirtualDisplayEnabled, getWebPreviewsEnabled } from "../preview/flags.js";
import type { LaneDeps } from "../preview/forward.js";
import { resolveSocket } from "./basics.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { PREVIEW_NODE_OFF } from "./preview-ports-exec.js";

/**
 * The `preview_open` arm (pane-preview spec 2026-10-21 §4/§6): the gate ladder
 * a watch request must walk, then the one call that starts the mechanism. The
 * ladder's ORDER is its whole point — mirror switch, pane liveness, the shared
 * budget — every refusal answers at the ladder, so a request that was never
 * going to register starts no dial, no timer, no lane, and no CDP handshake.
 *
 * - **The switch first**, like every preview arm: {@link PREVIEW_NODE_OFF} is
 *   the shared voice, asked fail-closed before any pane or port is consulted.
 * - **The pane second**: the forward twin of `preview_ports_get`'s refusal.
 *   A dead pane's port can be rebound by a stranger process, and a lane (or a
 *   screencast) dialed onto that is indistinguishable from watching another
 *   pane, so liveness is law before registration, not a fact the dial trusts.
 * - **The budget last, and it is ONE number**: spec §6's "16 per node" is a
 *   sum over BOTH registries (sixteen of any mix), checked before either
 *   mechanism starts. Both rungs sum the context registry's node-wide
 *   `laneCount()` with {@link bridgeCount}; a sum living only in one branch
 *   is how 32 total sessions come back, and a dial-then-refuse would leave a
 *   live connection behind for a request that was never going to register.
 *   Each refusal still names its own kind. The 4-per-pane cap stays lane-only:
 *   the screencast has no per-pane quota in the spec.
 *
 * The forward branch calls {@link PreviewForward.openLane}, which registers
 * synchronously and dials OFF the command chain (the ssh-relay A-branch
 * posture, restated there): the ack says `pending: true`, and a dial that
 * fails later reaches the plane as one `preview_closed`, never a second
 * answer to this command. The screencast branch AWAITS {@link startBridge}:
 * the open answers `{ ref, subscribers: 1 }` only once the CDP handshake and
 * `Page.startScreencast` have actually landed, and every handshake failure
 * answers the {@link PREVIEW_NOT_CDP} refusal with no half-started state:
 * the plane never holds a ref it has no live bridge behind.
 */

/** The node holds its 16 concurrent previews; a new LANE would be the 17th. */
export const PREVIEW_LANE_OVER_NODE_CAP = "preview-lane-over-node-cap";

/** The node holds its 16 concurrent previews; a new BRIDGE would be the 17th. */
export const PREVIEW_WATCH_OVER_NODE_CAP = "preview-watch-over-node-cap";

/** This pane holds its 4 lanes; a new open would be its 5th. */
export const PREVIEW_LANE_OVER_PANE_CAP = "preview-lane-over-pane-cap";

/** The pane the command names is not running here (anymore, or never). */
export const PREVIEW_PANE_GONE = "preview-pane-gone";

/**
 * The named port is not a Chrome DevTools endpoint this bridge can use: the
 * list refused, the URL answered a non-loopback host, the socket died or
 * never opened, or the handshake budget expired. Names the same word the
 * `preview_closed` reason set carries, so the plane maps a refusal onto the
 * copy it already maps the death onto.
 */
export const PREVIEW_NOT_CDP = "not-cdp";

/**
 * Execute `preview_open`: switch → pane → shared budget → start, in that
 * order. A malformed pane id refuses `invalid subshell id` through {@link
 * resolveSocket}'s throw, before tmux is asked anything — the same id gate
 * every pane executor runs first. `deps` is the lane mechanics seam
 * (`forward.ts`) and `bridgeDeps` the bridge's (`cdp-bridge.ts`); production
 * dispatch omits both and gets real net, real fetch/WebSocket, and real
 * (unref'd) timers.
 */
export async function execPreviewOpen(
  ctx: CommandContext,
  cmd: Cmd<"preview_open">,
  deps?: LaneDeps,
  bridgeDeps?: BridgeDeps,
): Promise<CommandResult> {
  if (getPreviewEnabled(ctx.config.dataDir)?.on !== true) return { ok: false, error: PREVIEW_NODE_OFF };
  if (cmd.kind !== "forward" && cmd.kind !== "screencast") return { ok: false, error: "unsupported" };
  const isScreen =
    cmd.kind === "forward" && !cmd.service && ctx.previewDisplays?.getFor(cmd.paneId)?.viewer.port === cmd.port;
  if (isScreen ? !getVirtualDisplayEnabled(ctx.config.dataDir) : !getWebPreviewsEnabled(ctx.config.dataDir)) {
    return { ok: false, error: isScreen ? "virtual-display-disabled" : PREVIEW_NODE_OFF };
  }
  const forward = ctx.previewForward;
  const send = ctx.sendPreviewEvent;
  if (!forward || !send) {
    // Not a user-facing condition: a daemon that runs commands without the
    // preview plumbing would half-open lanes with no event path, so this is
    // the impossible-state guard, answered loudly (the relay precedent).
    return { ok: false, error: "preview plumbing unavailable in this daemon context" };
  }
  const socket = await resolveSocket(ctx, cmd.paneId);
  const panePid = await ctx.tmux.panePid(socket, cmd.paneId);
  if (panePid === null) return { ok: false, error: PREVIEW_PANE_GONE };
  if (cmd.kind === "forward") {
    if (forward.laneCount(cmd.paneId) >= PREVIEW_FORWARD_SESSIONS_PER_PANE)
      return { ok: false, error: PREVIEW_LANE_OVER_PANE_CAP };
    if (forward.laneCount() + bridgeCount() >= PREVIEW_SESSIONS_PER_NODE)
      return { ok: false, error: PREVIEW_LANE_OVER_NODE_CAP };
    forward.openLane({
      ref: cmd.ref,
      port: cmd.port,
      service: cmd.service,
      paneId: cmd.paneId,
      lifetimeMs: cmd.lifetimeMs,
      hooks: { emit: (ev) => send(ev) },
      deps,
    });
    // The seam cast is the JSON-safety posture the sibling executors use
    // (`node-results.ts` owns the answer contract; a forward ack is a plain
    // object by the plan's interface note). One edge worth naming: if the ref
    // is already registered, `openLane` keeps the live lane and returns, so
    // this ack then describes the already-live lane (a dial that started at an
    // earlier open), not a dial that started here (forward.ts:142-144).
    return { ok: true, data: { ref: cmd.ref, pending: true } as unknown as JsonValue };
  }
  // The screencast branch: the shared budget BEFORE the dial (a refusal must
  // not leave a live CDP connection behind for a request that was never going
  // to register), and the absent `fps` defaults HERE: the wire grammar
  // rebuilds the command without it and leaves the defaulting to this arm.
  if (forward.laneCount() + bridgeCount() >= PREVIEW_SESSIONS_PER_NODE)
    return { ok: false, error: PREVIEW_WATCH_OVER_NODE_CAP };
  try {
    await startBridge({
      ref: cmd.ref,
      cdpPort: cmd.port,
      fps: cmd.fps ?? PREVIEW_WATCH_FPS_DEFAULT,
      lifetimeMs: cmd.lifetimeMs,
      // Block bodies on purpose: the sender returns void, and the seam's
      // accept-signal is `undefined` (a settled return means "accepted").
      emitStream: (ev) => {
        send(ev);
      },
      emitClosed: (ev) => {
        send(ev);
      },
      deps: bridgeDeps,
    });
  } catch {
    // Every handshake failure speaks `not-cdp` (`cdp-bridge.ts`): this port is
    // not a DevTools endpoint a watch can be built on. The open refuses; no
    // bridge is registered and no event is volunteered (the plane never held
    // this ref).
    return { ok: false, error: PREVIEW_NOT_CDP };
  }
  // One subscriber on birth: the plane's viewer (Task 8). The validator in
  // `node-results.ts` accepts this arm beside the lane's `pending: true`.
  return { ok: true, data: { ref: cmd.ref, subscribers: 1 } as unknown as JsonValue };
}
