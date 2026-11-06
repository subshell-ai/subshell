import type { JsonValue } from "@internal/subshell-protocol";
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
 * answer honest; the per-pane open/close queue inside PreviewDisplays keeps
 * it true against a concurrent launch or sweep.
 */
export async function execPreviewDisplayClose(
  ctx: CommandContext,
  cmd: Cmd<"preview_display_close">,
): Promise<CommandResult> {
  if (!ctx.previewDisplays) {
    return { ok: false, error: "preview plumbing unavailable in this daemon context" };
  }
  const closed = ctx.previewDisplays.getFor(cmd.paneId) !== null;
  await ctx.previewDisplays.closeFor(cmd.paneId);
  return { ok: true, data: { closed } as unknown as JsonValue };
}
