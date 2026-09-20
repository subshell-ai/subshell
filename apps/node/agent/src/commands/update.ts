import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED } from "@internal/subshell-protocol";
import { log } from "../log.js";
import { applyUpdate, type UpdateManifestSource, UpdateRefused } from "../update.js";
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
/** What `execUpdate` reads; see {@link ServiceExecContext} for why it is narrowed. */
export type UpdateExecContext = Pick<CommandContext, "runtime" | "config" | "binaryDeps" | "requestRestart">;

export async function execUpdate(ctx: UpdateExecContext, cmd: Cmd<"update">): Promise<CommandResult> {
  const runtime = ctx.runtime;

  if (!runtime?.supervised) {
    return { ok: false, error: NODE_RESULT_NOT_SUPERVISED };
  }
  if (cmd.force !== true && runtime.service.paneSafety !== "keeps") {
    return { ok: false, error: NODE_RESULT_KILLS_PANES };
  }

  // The signed manifest rides with the order (spec 2026-09-17 §6). BOTH parts
  // or neither: a command that carried a manifest without its signature (or
  // the reverse) cannot be verified, and "half a signature arrived" is the
  // same refusal as none — `applyUpdate` answers it before a byte of trust
  // lands anywhere. (Protocol <12 agents are never sent this command; the
  // plane refuses them with "agent predates signed updates".)
  const manifest: UpdateManifestSource | null =
    cmd.manifest !== undefined && cmd.manifestSig !== undefined
      ? { bytes: Buffer.from(cmd.manifest, "base64"), sig: cmd.manifestSig }
      : null;
  try {
    await applyUpdate({
      source: { kind: "url", url: cmd.url, sha256: cmd.sha256, manifest },
      version: cmd.version,
      force: cmd.force === true,
      // The daemon restarts; see the header. Passing `true` here would have
      // the agent ask its own service manager to restart the unit from inside
      // it, which is the exact mistake `service restart` exists not to make.
      restart: false,
      origin: "plane",
      dataDir: ctx.config.dataDir,
      binaryDeps: ctx.binaryDeps,
    });
  } catch (err) {
    // The wire constant, never the sentence: the plane maps
    // `NodeRpcError.detail` by equality, so a helpful message here becomes a
    // 409 naming nothing.
    //
    // Which means the SENTENCE has nowhere else to go, and it is the only
    // thing that says WHY. `download-failed` reaches the admin as "that node
    // could not download the new binary"; whether that was a 401 from a token
    // the plane had already forgotten, a 404, or a connection refused is
    // knowable only here. So it is logged on the machine it happened on,
    // where the node's owner can read it (`GET /api/nodes/:id/logs`). The
    // sentence is safe to log because `applyUpdate` builds it from
    // `redactUrl` — the query string it would otherwise carry is the
    // single-use `nut_…` token, which must not outlive the ten minutes that
    // bound it by sitting in a log file.
    if (err instanceof UpdateRefused) {
      log(`update refused (${err.detail}): ${err.message}`);
      return { ok: false, error: err.detail };
    }
    throw err;
  }

  ctx.requestRestart();
  return { ok: true };
}
