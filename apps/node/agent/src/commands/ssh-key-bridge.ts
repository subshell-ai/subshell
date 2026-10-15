import { closeSshKeyBridges, machineSshKeyBridge } from "@internal/pane-runtime";
import { NODE_RESULT_MAINTENANCE, type SshKeyBridgeCommand } from "@internal/subshell-protocol";
import { readMaintenance } from "../maintenance.js";
import type { CommandContext, CommandResult } from "./context.js";
import { gateOpen, SSH_GATE_REFUSAL } from "./ssh-shared.js";

/** Native key signing is gated on every exchange; cleanup is always allowed. */
export async function execSshKeyBridge(ctx: CommandContext, cmd: SshKeyBridgeCommand): Promise<CommandResult> {
  if (cmd.op !== "close") {
    if (!gateOpen(ctx)) {
      closeSshKeyBridges(ctx.config.dataDir);
      return { ok: false, error: SSH_GATE_REFUSAL };
    }
    const maintenance = readMaintenance(ctx.config.dataDir);
    if (maintenance.kind === "unreadable" || (maintenance.kind === "state" && maintenance.state.on)) {
      closeSshKeyBridges(ctx.config.dataDir);
      return { ok: false, error: NODE_RESULT_MAINTENANCE };
    }
  }
  return { ok: true, data: { ...(await machineSshKeyBridge(ctx.config.dataDir, cmd)) } };
}
