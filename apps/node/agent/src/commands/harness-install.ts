import type { Cmd, CommandContext, CommandResult } from "./context.js";
import { runHarnessLine } from "./harness-run.js";

/**
 * `harness_install` (protocol 29): run one harness CLI's installer line on
 * this machine.
 *
 * The line is the built-in manifest's `install.command`, sent by the control
 * plane as data (the node holds no plugin manifests since the inversion).
 * Everything about the run — the allowlisted environment, login-shell PATH,
 * closed stdin, the ten-minute deadline and the per-stream cap — is
 * {@link runHarnessLine}'s, deliberately the same bounds an update gets: both
 * are package-manager runs, and the answer shape (`ok`/`exitCode`/`output`/
 * `durationMs`/`timedOut`) is the same one the plane already parses.
 *
 * A non-zero exit is a RESULT (`ok:false` inside `data`), not a command
 * failure: an installer that ran and said no is an answer the person pressing
 * Install must see.
 */
export async function execHarnessInstall(_ctx: CommandContext, cmd: Cmd<"harness_install">): Promise<CommandResult> {
  return runHarnessLine(cmd.harnessId, cmd.command, "installer");
}
