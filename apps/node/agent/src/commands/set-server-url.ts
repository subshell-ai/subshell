import { runConfigure } from "../configure.js";
import { log } from "../log.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `set_server_url`: repoint this node at another control plane.
 *
 * Straight through {@link runConfigure} — the same function `subshell
 * configure --server` calls — because `config.json` holds the only copy of the
 * node key and a second writer of that file would be a second set of rules for
 * it. That function validates before it reads, writes exactly once, keeps
 * `nodeId`/`nodeKey`/`controlPublicKey`, and clears the enroll-time
 * `nodeWsUrl` so the daemon stops dialing the old host.
 *
 * **The new address does not take effect until the agent restarts**, and this
 * command deliberately does not restart it. The plane says so, and the operator
 * chooses when — a machine that vanished mid-command because it silently
 * re-dialed somewhere else is the kind of surprise this whole surface exists to
 * remove.
 *
 * Logged, because this is the one command that changes which plane owns this
 * machine, and the log is the only record of it that stays ON the machine.
 */
export async function execSetServerUrl(_ctx: CommandContext, cmd: Cmd<"set_server_url">): Promise<CommandResult> {
  try {
    const next = await runConfigure({ server: cmd.url });
    log(`configured: server url is now ${next.serverUrl} (takes effect on the next restart)`);
    return { ok: true, data: next.serverUrl };
  } catch (err) {
    // The CLI's own refusal, verbatim: it owns the wording of an unusable URL
    // and of a machine with no config to repoint.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
