import { BackendErrorCodes } from "@internal/backend-errors";
import { db } from "@/db/index.js";
import { nodeCanLaunchOn } from "@/modules/nodes/access.js";
import { loadNodeGate, type NodeGate } from "@/modules/nodes/gate.js";
import { getHeld, getLive } from "@/modules/nodes/node-registry.js";
import { lockdownEnabled } from "@/modules/server/lockdown.js";
import { serverSubshellsEnabled } from "@/modules/server/server-as-node.js";
import type { SshAnswer } from "@/modules/ssh/ssh-launch.service.js";

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

/** The two instance-level facts `sshPolicy` reads, so a multi-row view fetches them once. */
export interface SshPolicyConfig {
  /** The instance lockdown switch. */
  lockdown: boolean;
  /** Whether launching subshells on the server itself is enabled. */
  serverAccountEnabled: boolean;
}

/** Read the instance-level policy facts once for a whole view (Settings → SSH readiness). */
export async function sshPolicyConfig(): Promise<SshPolicyConfig> {
  const [lockdown, serverAccountEnabled] = await Promise.all([lockdownEnabled(db), serverSubshellsEnabled(db)]);
  return { lockdown, serverAccountEnabled };
}

export async function sshReadiness(gate: NodeGate, config?: SshPolicyConfig) {
  const { lockdown, serverAccountEnabled } = config ?? (await sshPolicyConfig());
  const live = gate.row.kind === "agent" ? getLive(gate.row.id) : undefined;
  return sshPolicy(gate, {
    lockdown,
    serverAccountEnabled,
    held: gate.row.kind === "agent" && !!getHeld(gate.row.id),
    online: gate.row.kind === "local" || (!!live && !live.closing),
    ready: gate.row.kind === "local" || !!live?.agent?.dataDir,
  });
}

/**
 * Which policy blockers count as the viewer LOSING authorization to keep a
 * live session. Maintenance is excluded: it's a routing preference, never a
 * revocation, so a key-home machine slipping into maintenance must not cut a
 * live relay whose pane runs on the OTHER node. `sshAccessRevoked` neutralizes
 * lockdown and liveness through the policy state, but maintenance is a ROW fact
 * that survives that neutralization, so it has to be filtered here too.
 */
export function blockersRevokeAccess(blockers: SshBlocker[]): boolean {
  return blockers.some((b) => b.code !== BackendErrorCodes.NODE_IN_MAINTENANCE);
}

/**
 * Whether the viewer has lost the AUTHORIZATION to keep a live SSH session on
 * this machine: no row or gate left, launch access gone, outgoing SSH switched
 * off on it. Liveness (offline, held, still-connecting) and maintenance are
 * deliberately NOT here — a link blip or a maintenance flip is not an access
 * decision, and `closeUnauthorizedForNode` must not cut a healthy pairing for
 * one. The lockdown is excluded for the same reason: it refuses NEW
 * connections; it has never claimed the live ones.
 */
export async function sshAccessRevoked(viewerId: string, nodeId: string): Promise<boolean> {
  const gate = await loadNodeGate(viewerId, nodeId);
  if (!gate) return true;
  const policy = sshPolicy(gate, {
    lockdown: false,
    serverAccountEnabled: await serverSubshellsEnabled(db),
    held: false,
    online: true,
    ready: true,
  });
  return blockersRevokeAccess(policy.blockers);
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
