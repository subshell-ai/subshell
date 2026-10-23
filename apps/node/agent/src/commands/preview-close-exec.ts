import type { JsonValue } from "@internal/subshell-protocol";
import { stopBridge } from "../preview/cdp-bridge.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * Execute `preview_close` (pane-preview spec 2026-10-21 §4, Tasks 5-6): end
 * the lane or bridge named by the ref. Deliberately NOT gated — the
 * `set_ssh_enabled` and `ssh_relay_close` doctrine: a switch-off mid-session
 * must still be able to end a live session, because teardown is not a preview
 * act, and refusing it would strand a dialed socket (or a live screencast) on
 * a machine that has stopped serving previews. The plane does not tell the
 * node which registry holds a ref, so the lookup falls through: the forward
 * registry answers first, and a miss consults the bridge registry. An unknown
 * ref answers `closed: false` — a close racing the session's own death is
 * routine, and the false answer is the honest record, not an error (both
 * registries register before the open acks, so there is no detached-open race
 * to tombstone; the ref exists from the ack onward).
 */
export function execPreviewClose(ctx: CommandContext, cmd: Cmd<"preview_close">): CommandResult {
  const forward = ctx.previewForward;
  if (!forward) {
    // The impossible-state guard again: no preview plumbing, no sessions to close.
    return { ok: false, error: "preview plumbing unavailable in this daemon context" };
  }
  const { closed } = forward.closeLane(cmd.ref, cmd.reason);
  const stopped = closed ? false : stopBridge(cmd.ref, cmd.reason);
  return { ok: true, data: { ref: cmd.ref, closed: closed || stopped } as unknown as JsonValue };
}
