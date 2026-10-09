import { machineSshExec, machineSshExecStatus, type SshExecSeams } from "@internal/pane-runtime";
import { NODE_RESULT_MAINTENANCE, type SshExecCommand, type SshExecStatusCommand } from "@internal/subshell-protocol";
import { readMaintenance } from "../maintenance.js";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { CommandContext, CommandResult } from "./context.js";
import { SSH_GATE_REFUSAL } from "./ssh-shared.js";

export { resetSshExecRunsForTests, type SshExecSeams } from "@internal/pane-runtime";
/** Enforce daemon policy before invoking the shared machine executor. */
export async function execSshExec(
  ctx: CommandContext,
  cmd: SshExecCommand,
  seams?: SshExecSeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  const maintenance = readMaintenance(ctx.config.dataDir);
  if (maintenance.kind === "unreadable" || (maintenance.kind === "state" && maintenance.state.on))
    return { ok: false, error: NODE_RESULT_MAINTENANCE };
  return machineSshExec(ctx.config.dataDir, cmd, seams);
}
/** Read the bounded result retained by the shared executor. */
export async function execSshExecStatus(
  ctx: CommandContext,
  cmd: SshExecStatusCommand,
  seams?: SshExecSeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  return machineSshExecStatus(ctx.config.dataDir, cmd, seams);
}
