import type { JsonValue } from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * Execute `preview_close` (pane-preview spec 2026-10-21 §4, Task 5): end the
 * lane named by the ref. Deliberately NOT gated — the `set_ssh_enabled` and
 * `ssh_relay_close` doctrine: a switch-off mid-session must still be able to
 * end a live lane, because teardown is not a preview act, and refusing it
 * would strand a dialed socket on a machine that has stopped serving
 * previews. An unknown ref answers `closed: false` — a close racing the
 * lane's own death is routine, and the false answer is the honest record, not
 * an error (`forward.ts`'s synchronous registration means there is no
 * detached-open race to tombstone; the ref exists from the ack onward).
 */
export function execPreviewClose(ctx: CommandContext, cmd: Cmd<"preview_close">): CommandResult {
  const forward = ctx.previewForward;
  if (!forward) {
    // The impossible-state guard again: no preview plumbing, no lanes to close.
    return { ok: false, error: "preview plumbing unavailable in this daemon context" };
  }
  const { closed } = forward.closeLane(cmd.ref, cmd.reason);
  return { ok: true, data: { ref: cmd.ref, closed } as unknown as JsonValue };
}
