import { writeMaintenance } from "../maintenance.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `set_maintenance` (spec 2026-09-14 §4.4): the plane's half of the flag.
 *
 * It writes the file and NOTHING else. In particular it kills no panes: a
 * plane-side flip has already terminated every row it knew about through the
 * ordinary per-subshell path, which does the bookkeeping a blind kill here
 * could not — token revocation, the audit row, the owner's notification. A
 * pane this machine holds that the plane does NOT know about is a row the
 * plane never created, and killing it from a frame about a flag would be the
 * node inventing a teardown nobody recorded.
 *
 * The plane's own `changedAt` is stored verbatim, so both copies end
 * byte-identical; re-stamping would leave the next reconnect reconciling a
 * difference that is only the latency between the two writes.
 *
 * A failing write propagates: `dispatchCommand` turns the throw into
 * `{ ok: false }`, and the plane learns its push did not land rather than
 * recording a mirror that does not exist.
 *
 * @param ctx - the per-daemon execution context (data dir + the report memo)
 * @param cmd - the verified `set_maintenance` command
 * @returns `{ ok: true }` once the file is on disk
 */
export function execSetMaintenance(ctx: CommandContext, cmd: Cmd<"set_maintenance">): CommandResult {
  // Memoized as REPORTED, not merely written: the plane is the source of this
  // value, so sending it back on the next heartbeat would be an echo it would
  // then reconcile against its own row.
  ctx.lastReportedMaintenance = writeMaintenance(ctx.config.dataDir, { on: cmd.on, changedAt: cmd.changedAt });
  return { ok: true };
}
