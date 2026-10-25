import { setPreviewEnabled } from "../preview/flags.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `set_preview_enabled` (pane-preview spec Task 3): the plane's half of the
 * preview switch, reached only through `dispatchCommand`'s already-verified
 * frame: an unsigned or misauthenticated command never gets this far.
 *
 * It writes the file and NOTHING else. In particular it opens no lane and
 * revokes nothing: the gate is checked when a preview act is asked for, so
 * turning it off takes effect on the next one, and turning it on grants no
 * viewer anything the plane's sharing had not already admitted.
 *
 * The plane's own `changedAt` is stored verbatim, so both copies end
 * byte-identical; re-stamping would leave the next `ready` reporting a
 * disagreement the link latency invented.
 *
 * A failing write propagates: `dispatchCommand` turns the throw into
 * `{ ok: false }`, and the plane learns its push did not land rather than
 * recording a mirror that does not exist.
 *
 * @param ctx - the per-daemon execution context (data dir + the report memo)
 * @param cmd - the verified `set_preview_enabled` command
 * @returns `{ ok: true }` once the file is on disk
 */
export function execSetPreviewEnabled(ctx: CommandContext, cmd: Cmd<"set_preview_enabled">): CommandResult {
  // Memoized as REPORTED, not merely written: the plane is the source of this
  // value, the ONLY source it will ever have, so sending it back on the next
  // heartbeat tick would be an echo the plane then reconciles against itself.
  ctx.lastReportedPreviewEnabled = setPreviewEnabled(ctx.config.dataDir, {
    on: cmd.on,
    changedAt: cmd.changedAt,
    ...(cmd.appsOn === undefined ? {} : { appsOn: cmd.appsOn }),
    ...(cmd.displayOn === undefined ? {} : { displayOn: cmd.displayOn }),
  });
  return { ok: true };
}
