import { type HostKeySeams, readMachineHostKey } from "@internal/pane-runtime";
import type { SshHostKeyCommand } from "@internal/subshell-protocol";
import type { CommandContext, CommandResult } from "./context.js";
import { gateOpen, SSH_GATE_REFUSAL } from "./ssh-shared.js";

export { type HostKeySeams, sshHostKeyCandidates } from "@internal/pane-runtime";
/** Gate machine trust capture before reading the account's file. */
export async function execSshHostKey(
  ctx: CommandContext,
  cmd: SshHostKeyCommand,
  seams?: HostKeySeams,
): Promise<CommandResult> {
  if (!gateOpen(ctx)) return { ok: false, error: SSH_GATE_REFUSAL };
  return readMachineHostKey(cmd, seams);
}
