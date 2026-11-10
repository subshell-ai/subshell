import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { runHarnessLine } from "./harness-run.js";

/**
 * `harness_update` (protocol 28): run one harness CLI's own update line on
 * this machine.
 *
 * The line arrives from the control plane because the node has held no plugin
 * manifests since the inversion (spec 2026-09-10 §6): it is the manifest's
 * `subshell.update.command`, or its `install.command` when the installer
 * doubles as the updater. Everything about the run — the allowlisted
 * environment, login-shell PATH, closed stdin, the ten-minute deadline and the
 * per-stream cap — is {@link runHarnessLine}'s, shared with `harness_install`.
 *
 * A non-zero exit is a RESULT (`ok:false` inside `data`), not a command
 * failure: the update ran and said no, which is what the person pressing the
 * button needs to see.
 */
export async function execHarnessUpdate(_ctx: CommandContext, cmd: Cmd<"harness_update">): Promise<CommandResult> {
  return runHarnessLine(cmd.harnessId, cmd.command, "update");
}
