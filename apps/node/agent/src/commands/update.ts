import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED } from "@internal/subshell-protocol";
import { applyUpdate, UpdateRefused } from "../update.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `update`: replace this agent's binary with the one the plane names, then
 * restart into it (spec 2026-09-15 §5.2).
 *
 * **An update is a restart with a file swap in front of it, so it inherits
 * both of `service restart`'s refusals** — verbatim, from
 * `commands/service.ts`, and in the same order:
 *
 * - **Not supervised** comes first, because it is the most specific truth:
 *   exiting is a restart only when the manager started THIS pid, and on a
 *   foreground `subshell run` exiting is a stop. Swapping the binary and then
 *   discovering that would leave a machine holding a new file it never runs.
 * - **Pane safety** fails CLOSED on `unknown` AND on no report at all. A
 *   missing `runtime` is less evidence of safety than an unreadable
 *   definition, not more — the same correction `execService` carries.
 *
 * Both are checked BEFORE anything is downloaded. A refusal that arrives after
 * 70 MB has crossed the wire is a worse refusal for having been late, and the
 * plane's own 409 mapping reads the same constants either way.
 *
 * **The `result` frame goes out first, the exit follows.** `applyUpdate` is
 * called with `restart: false` and the executor answers `{ ok: true }`, then
 * asks the daemon to exit — the daemon is the only sender of `result`, so an
 * executor that restarted itself would reach the plane as a TIMEOUT for an
 * update that in fact worked. Exactly the shape `service restart` uses.
 *
 * What happens next is not this function's business and is the point of the
 * whole design: the manager respawns the agent, it dials the plane, and either
 * the connection is accepted (the daemon deletes `.previous` and the marker)
 * or it is closed 4406 (the daemon swaps `.previous` back and exits 1, so the
 * manager brings the PREVIOUS version up on a machine nobody had to visit).
 */
export async function execUpdate(ctx: CommandContext, cmd: Cmd<"update">): Promise<CommandResult> {
  const runtime = ctx.runtime;

  if (!runtime?.supervised) {
    return { ok: false, error: NODE_RESULT_NOT_SUPERVISED };
  }
  if (cmd.force !== true && runtime.service.paneSafety !== "keeps") {
    return { ok: false, error: NODE_RESULT_KILLS_PANES };
  }

  try {
    await applyUpdate({
      source: { kind: "url", url: cmd.url, sha256: cmd.sha256 },
      version: cmd.version,
      force: cmd.force === true,
      // The daemon restarts; see the header. Passing `true` here would have
      // the agent ask its own service manager to restart the unit from inside
      // it, which is the exact mistake `service restart` exists not to make.
      restart: false,
      origin: "plane",
      dataDir: ctx.config.dataDir,
    });
  } catch (err) {
    // The wire constant, never the sentence: the plane maps
    // `NodeRpcError.detail` by equality, so a helpful message here becomes a
    // 500 naming nothing. The sentence is in the agent's own log already.
    if (err instanceof UpdateRefused) return { ok: false, error: err.detail };
    throw err;
  }

  ctx.requestRestart();
  return { ok: true };
}
