import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED } from "@internal/subshell-protocol";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `restart`: exit for the service manager to respawn this agent
 * (spec 2026-09-12 § 6.3).
 *
 * Refused when this process is not the one the manager started — exiting
 * would just stop the daemon — and, mirroring `subshell service restart`,
 * when the installed definition would take live panes down, unless `force`.
 * `unknown` pane safety fails CLOSED with the rest, exactly as the CLI's
 * destructive verbs do: the definition exists but could not be read.
 *
 * The exit is the DAEMON's: this returns `{ ok: true }` so the result frame
 * goes out first, and only then does {@link CommandContext.requestRestart}
 * take the socket down.
 */
export async function execRestart(ctx: CommandContext, cmd: Cmd<"restart">): Promise<CommandResult> {
  const runtime = ctx.runtime;
  if (!runtime?.supervised) return { ok: false, error: NODE_RESULT_NOT_SUPERVISED };
  if (runtime.service.paneSafety !== "keeps" && cmd.force !== true) {
    return { ok: false, error: NODE_RESULT_KILLS_PANES };
  }
  ctx.requestRestart();
  return { ok: true };
}
