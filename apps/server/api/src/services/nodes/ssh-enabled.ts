import { getRequestlessContext } from "@/lib/context.js";
import { audit } from "@/services/audit.js";

/**
 * The node SSH capability flag (spec 4.3), written in exactly one place — the
 * posture `maintenance.ts` established and for the same reason: two
 * implementations of the change act is two implementations that drift, and
 * the half that drifts is whichever one nobody exercised. Task 7 layers the
 * node-side mirror (push + reconcile) into this same function.
 */

export interface SshEnabledWrite {
  nodeId: string;
  on: boolean;
  changedAt: string;
  actorUserId: string;
}

/** Flip one node's SSH capability: row, audit, and (from Task 7) the best-effort
 * push - all in this one function, so no caller can perform half the act. */
export async function setNodeSshEnabled(write: SshEnabledWrite): Promise<void> {
  const { repos } = getRequestlessContext();
  await repos.nodes.setSshEnabled(write.nodeId, { on: write.on, changedAt: write.changedAt });
  await audit({
    actorUserId: write.actorUserId,
    action: "node.ssh_enabled.update",
    targetType: "node",
    targetId: write.nodeId,
    metadataJson: JSON.stringify({ on: write.on }),
  });
  // Task 7 appends here: void pushSetSshEnabled(write.nodeId, { on: write.on, changedAt: write.changedAt });
}
