import { BackendErrorCodes } from "@internal/backend-errors";
import { loadNodeGate, type NodeGate } from "@/api/nodes/node-gate.js";
import { db } from "@/db/index.js";
import { nodeCanLaunchOn } from "@/lib/node-access.js";
import { lockdownEnabled } from "@/services/lockdown.js";
import { getHeld, getLive } from "@/services/nodes/node-registry.js";
import { serverSubshellsEnabled } from "@/services/server-as-node.js";
import type { SshAnswer } from "@/services/ssh-launch.service.js";

export interface SshBlocker {
  code: BackendErrorCodes;
  message: string;
}

/** One policy for machine discovery, SSH operations and UI readiness. */
export function sshPolicy(
  gate: NodeGate,
  state: {
    lockdown: boolean;
    serverAccountEnabled: boolean;
    held: boolean;
    online: boolean;
    ready: boolean;
  },
): { canConnect: boolean; canConfigure: boolean; blockers: SshBlocker[] } {
  const blockers: SshBlocker[] = [];
  const block = (code: BackendErrorCodes, message: string) => blockers.push({ code, message });
  if (state.lockdown)
    block(
      BackendErrorCodes.SSH_GATE_OFF,
      "Lockdown is blocking new SSH connections. An admin can end it in server settings.",
    );
  if (!nodeCanLaunchOn(gate.row.kind, gate.access, gate.granted, false, state.serverAccountEnabled)) {
    block(
      BackendErrorCodes.SSH_GATE_OFF,
      gate.row.kind === "local" && !state.serverAccountEnabled
        ? "Launching subshells on the server is switched off. An admin can allow it in server settings."
        : "You need permission to start subshells on this machine before using it for SSH.",
    );
  }
  if (gate.row.sshEnabled !== 1) block(BackendErrorCodes.SSH_GATE_OFF, "Outgoing SSH is disabled on this node.");
  if (gate.row.maintenance === 1)
    block(
      BackendErrorCodes.NODE_IN_MAINTENANCE,
      "This machine is in maintenance. Wait for maintenance to end before connecting.",
    );
  if (state.held) block(BackendErrorCodes.NODE_PROTOCOL_HELD, "Update Subshell on this machine before using SSH.");
  else if (!state.online) block(BackendErrorCodes.NODE_OFFLINE, "Start Subshell on this machine to bring it online.");
  else if (!state.ready)
    block(
      BackendErrorCodes.NODE_OFFLINE,
      "This machine is still connecting to the server. Try again once it’s online.",
    );
  return { canConnect: blockers.length === 0, canConfigure: gate.canManage, blockers };
}

export async function sshReadiness(gate: NodeGate) {
  const live = gate.row.kind === "agent" ? getLive(gate.row.id) : undefined;
  return sshPolicy(gate, {
    lockdown: await lockdownEnabled(db),
    serverAccountEnabled: await serverSubshellsEnabled(db),
    held: gate.row.kind === "agent" && !!getHeld(gate.row.id),
    online: gate.row.kind === "local" || (!!live && !live.closing),
    ready: gate.row.kind === "local" || !!live?.agent?.dataDir,
  });
}

/** Invisible and absent machines have the same 404; refuse before any RPC. */
export async function gateSshNode(viewerId: string, nodeId: string): Promise<SshAnswer<NodeGate>> {
  const gate = await loadNodeGate(viewerId, nodeId);
  if (!gate)
    return { ok: false, refusal: { status: 404, code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" } };
  const policy = await sshReadiness(gate);
  const blocker = policy.blockers[0];
  if (blocker)
    return { ok: false, refusal: { status: blocker.code === BackendErrorCodes.SSH_GATE_OFF ? 403 : 409, ...blocker } };
  return { ok: true, value: gate };
}
