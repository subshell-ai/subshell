import type { Node } from "@internal/node-admin";

/** SSH uses the machine owner's account, so a shared launch grant is insufficient. */
export function sshMachineBlocker(node: Node): string | null {
  if (!node.canManage) return "SSH is available only to this machine’s owner, or an admin on the server.";
  if (node.held) return "Update Subshell on this machine before using SSH.";
  if (node.maintenance) return "End maintenance on this machine before using SSH.";
  if (node.kind === "agent" && node.status !== "online") return "Start Subshell on this machine to bring it online.";
  if (!node.canLaunch) return "Allow subshell launches on this machine before using SSH.";
  if (!node.sshEnabled)
    return node.kind === "local"
      ? "SSH is off here. An admin can switch it on from this machine's settings."
      : "SSH is off on this machine. Its owner can switch it on from this machine's settings.";
  return null;
}
