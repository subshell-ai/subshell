import { type HostKeySeams, readMachineHostKey } from "@internal/pane-runtime";
import type { SshHostKeyCommand } from "@internal/subshell-protocol";
import { readSshEnabled, sshAllowed } from "../ssh-enabled.js";
import type { CommandContext, CommandResult } from "./context.js";
import { SSH_GATE_REFUSAL } from "./ssh-shared.js";

export { type HostKeySeams, sshHostKeyCandidates } from "@internal/pane-runtime";
/** Gate machine trust capture before reading the account's file. */
export async function execSshHostKey(
  ctx: CommandContext,
  cmd: SshHostKeyCommand,
  seams?: HostKeySeams,
): Promise<CommandResult> {
  if (!sshAllowed(readSshEnabled(ctx.config.dataDir))) return { ok: false, error: SSH_GATE_REFUSAL };
  return readMachineHostKey(cmd, seams);
}
