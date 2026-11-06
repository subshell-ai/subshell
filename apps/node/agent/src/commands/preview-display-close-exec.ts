import type { JsonValue } from "@internal/subshell-protocol";
import { isSubshellId } from "../subshell-meta.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * Execute `preview_display_close` (spec 2026-11-06): end the display this
 * pane's id owns, leaving the pane itself running. Deliberately NOT
 * policy-gated, the `preview_close` doctrine: the node switch being off (or a
 * provider leaving the enabled set) must never block a teardown, because the
 * refused act would strand Xvfb/x11vnc (or a BetterDisplay screen) on a
 * machine that stopped serving displays. `closeFor` is idempotent across the
 * provider registry, so an unallocated pane is routine: the answer is
 * `closed: false`, not an error. The pre-read of `getFor` is what makes that
 * answer honest as of the moment it reads, and the per-pane open/close queue
 * inside PreviewDisplays keeps the ordering true against a concurrent launch,
 * whose `openFor` waits behind this close. The orphan sweep is NOT in that
 * queue: `sweepOrphans` in `packages/pane-runtime/src/preview/display.ts`
 * walks the providers directly, so a sweep landing mid-flight can take the
 * display down first and the queued `closeFor` then finds nothing. One
 * cosmetic edge rides the other side of that gap, and the sweep is its only
 * actor: a launch cannot land between the pre-read and the close, because
 * launch runs on the serialized executor chain (only `input` rides its own
 * chain, and it allocates nothing) and these two calls sit in one synchronous
 * span. A sweep rehydrating a display
 * there leaves `closed: false` while `closeFor` tears down what that sweep
 * just brought back. Nothing consumes `closed` in the SPA, so this is
 * recorded, not fixed.
 */
export async function execPreviewDisplayClose(
  ctx: CommandContext,
  cmd: Cmd<"preview_display_close">,
): Promise<CommandResult> {
  // The id guard every sibling composition site keeps: `closeFor` ends at the
  // providers' per-pane dirs under the data dir, so a hostile id like
  // `../../../../x` must be refused before the registry, the queue, or any
  // path built from it is touched — the same `invalid subshell id` result
  // `launch` and the `allocate` path answer (launch.ts's gate, display.ts's).
  if (!isSubshellId(cmd.paneId)) return { ok: false, error: "invalid subshell id" };
  if (!ctx.previewDisplays) {
    return { ok: false, error: "preview plumbing unavailable in this daemon context" };
  }
  const closed = ctx.previewDisplays.getFor(cmd.paneId) !== null;
  await ctx.previewDisplays.closeFor(cmd.paneId);
  return { ok: true, data: { closed } as unknown as JsonValue };
}
