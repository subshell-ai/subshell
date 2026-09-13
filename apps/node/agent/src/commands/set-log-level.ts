import { setDebugLogging } from "../debug-logging.js";
import { log } from "../log.js";
import type { Cmd, CommandContext, CommandResult } from "./context.js";

/**
 * `set_log_level`: turn debug-level lines in this agent's own log file on or off.
 *
 * Live — it flips the file transport's level, no restart — and persisted in
 * `config.json`, because the sessions worth debugging are the ones that end in
 * a restart and a flag that reset there would turn debugging a crash loop into
 * a race.
 *
 * Refused while `SUBSHELL_DEBUG_LOGGING` forces it on in this machine's
 * environment: the environment wins everywhere else on this config ladder, and
 * writing a value the next read would mask is a success report for a change
 * that never happened.
 *
 * Logged at `info`, so the record of the switch survives the switch being
 * turned back off — a line written at `debug` about enabling `debug` is only
 * there for people who already had it on.
 */
export async function execSetLogLevel(_ctx: CommandContext, cmd: Cmd<"set_log_level">): Promise<CommandResult> {
  try {
    const state = await setDebugLogging(cmd.debug);
    log(`debug logging ${state.debug ? "enabled" : "disabled"}`);
    return { ok: true, data: state.debug };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
