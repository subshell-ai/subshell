import { writeSshEnabled } from "../ssh-enabled.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `set_ssh_enabled` (spec 2026-10-07 §4.3): the plane's half of the SSH gate.
 *
 * It writes the file and NOTHING else. In particular it kills no panes and
 * revokes nothing: the gate is checked when an SSH act is asked for, so
 * turning it off takes effect on the next one, and turning it on grants no
 * pane anything that was not already reachable by other means.
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
 * @param cmd - the verified `set_ssh_enabled` command
 * @returns `{ ok: true }` once the file is on disk
 */
export function execSetSshEnabled(ctx: CommandContext, cmd: Cmd<"set_ssh_enabled">): CommandResult {
  // Memoized as REPORTED, not merely written: the plane is the source of this
  // value — the ONLY source it will ever have — so sending it back on the next
  // heartbeat tick would be an echo the plane then reconciles against itself.
  ctx.lastReportedSshEnabled = writeSshEnabled(ctx.config.dataDir, { on: cmd.on, changedAt: cmd.changedAt });
  return { ok: true };
}
