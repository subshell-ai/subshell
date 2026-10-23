import {
  type JsonValue,
  PREVIEW_FORWARD_SESSIONS_PER_PANE,
  PREVIEW_SESSIONS_PER_NODE,
} from "@internal/subshell-protocol";
import { getPreviewEnabled } from "../preview/flags.js";
import type { LaneDeps } from "../preview/forward.js";
import { resolveSocket } from "./basics.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { PREVIEW_NODE_OFF } from "./preview-ports-exec.js";

/**
 * The `preview_open` arm (pane-preview spec 2026-10-21 §4/§6, Task 5): the
 * gate ladder a forward-lane request must walk, then the one call that starts
 * the mechanism. The ladder's ORDER is its whole point — mirror switch, pane
 * liveness, budgets — every refusal answers at the ladder, so a request that
 * was never going to register starts no dial, no timer, and no lane.
 *
 * - **The switch first**, like every preview arm: {@link PREVIEW_NODE_OFF} is
 *   the shared voice, asked fail-closed before any pane or port is consulted.
 * - **The pane second**: the forward twin of `preview_ports_get`'s refusal.
 *   A dead pane's port can be rebound by a stranger process, and a lane
 *   dialed onto that is indistinguishable from dialing another pane's server,
 *   so liveness is law before registration, not a fact the dial trusts.
 * - **The budgets last**: 4 lanes per pane, 16 per node (spec §6). At this
 *   task only forward lanes consume the counter; Task 6's bridges join the
 *   same numbers, which is why the rungs read
 *   {@link PreviewForward.laneCount} and never a private tally.
 *
 * A passing ladder calls {@link PreviewForward.openLane}, which registers
 * synchronously and dials OFF the command chain (the ssh-relay A-branch
 * posture, restated there): the ack says `pending: true`, and a dial that
 * fails later reaches the plane as one `preview_closed`, never a second
 * answer to this command. The `screencast` kind is Task 6's branch; until it
 * lands the arm answers the integration contract word `unsupported`, which is
 * what the plane's compat logic already reads for a node that lacks a
 * feature.
 */

/** The node holds its 16 concurrent lanes; a new open would be the 17th. */
export const PREVIEW_LANE_OVER_NODE_CAP = "preview-lane-over-node-cap";

/** This pane holds its 4 lanes; a new open would be its 5th. */
export const PREVIEW_LANE_OVER_PANE_CAP = "preview-lane-over-pane-cap";

/** The pane the command names is not running here (anymore, or never). */
export const PREVIEW_PANE_GONE = "preview-pane-gone";

/**
 * Execute `preview_open`: switch → pane → budgets → register, in that order.
 * A malformed pane id refuses `invalid subshell id` through {@link
 * resolveSocket}'s throw, before tmux is asked anything — the same id gate
 * every pane executor runs first. `deps` is the mechanics seam
 * (`forward.ts`); production dispatch omits it and gets real net and real
 * (unref'd) timers.
 */
export async function execPreviewOpen(
  ctx: CommandContext,
  cmd: Cmd<"preview_open">,
  deps?: LaneDeps,
): Promise<CommandResult> {
  if (getPreviewEnabled(ctx.config.dataDir)?.on !== true) return { ok: false, error: PREVIEW_NODE_OFF };
  if (cmd.kind !== "forward") return { ok: false, error: "unsupported" };
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
  if (forward.laneCount(cmd.paneId) >= PREVIEW_FORWARD_SESSIONS_PER_PANE)
    return { ok: false, error: PREVIEW_LANE_OVER_PANE_CAP };
  if (forward.laneCount() >= PREVIEW_SESSIONS_PER_NODE) return { ok: false, error: PREVIEW_LANE_OVER_NODE_CAP };
  forward.openLane({
    ref: cmd.ref,
    port: cmd.port,
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
