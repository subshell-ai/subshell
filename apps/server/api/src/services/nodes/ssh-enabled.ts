import type { NodeSshEnabledWire } from "@internal/subshell-protocol";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { audit } from "@/services/audit.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * The node SSH capability flag (spec 2026-10-07 §4.3), written in exactly one
 * place — the posture `maintenance.ts` established and for the same reason:
 * two implementations of the change act is two implementations that drift,
 * and the half that drifts is whichever one nobody exercised.
 *
 * **The differences from maintenance are all in one fact: the plane is the
 * SOLE writer.** There is no `subshell ssh-enabled` verb, so there is no
 * second stamp to race — reconciliation never compares dates, never adopts,
 * and answers every disagreement the same way: push the row. That is also
 * why {@link SshEnabledWrite} has no `source` field and its `actorUserId`
 * cannot be null: the only caller that reaches the row is a human's request,
 * and the reconcile path performs no write at all.
 */

export interface SshEnabledWrite {
  nodeId: string;
  on: boolean;
  changedAt: string;
  actorUserId: string;
}

/** Flip one node's SSH capability: row, audit, and the best-effort push —
 * all in this one function, so no caller can perform half the act. */
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
  // The row is written and audited BEFORE the push, so a node that answers the
  // command cannot be looking at a mirror the record has not caught up to —
  // and a push that fails (the node is offline) costs nothing: the value
  // re-lands at the node's next `ready` through {@link reconcileSshEnabled}.
  pushSetSshEnabledBestEffort(write.nodeId, { on: write.on, changedAt: write.changedAt });
}

/** The node-row fields {@link decideSshEnabled} reads — nothing else is relevant. */
type SshRow = Pick<NodeTable, "sshEnabled" | "sshEnabledAt">;

/** What reconciliation decided about one node's two copies of the flag. */
export type SshDecision = "push-plane" | "noop";

/**
 * Decide what to do when the plane's row and the node's report disagree.
 * PURE — it reads two values and answers; the caller performs.
 *
 * The table, and why each row is what it is (spec §4.3 — no node writer, so
 * this is maintenance's `decideMaintenance` with the stamp comparison struck
 * out; there is no "node wrote newer" case to price):
 *
 * | node reports | plane row | → |
 * |---|---|---|
 * | nothing | off / never written | `noop` — silence means refusal HERE, and the row already refuses |
 * | nothing | on | `push-plane` — the node has no file (or a lost one); give it ours |
 * | the row's value | — | `noop` — agreement, the steady state; a push here would echo forever |
 * | the other value | with a stamp | `push-plane` — the row is the record; the machine is told, never asked |
 * | the other value | never written | `noop` — nothing to send (no stamp exists), and the disagreement is INERT: the plane gates every SSH act on the row, so a stale mirror-on permits nothing the row permits |
 *
 * Stamps are never compared: with no node-side writer, a differing
 * `changedAt` under an agreeing `on` is just a value relayed through the
 * link — pushing on it would be a command per heartbeat for a difference that
 * is only latency. And NOTHING adopts: an old mirror, a corrupted mirror
 * reporting the refusal it produces, a future one — none of them move the
 * row. That is the direction this whole task exists to pin.
 *
 * @param row - the plane's node row (the two SSH fields only)
 * @param reported - what the machine says its mirror answers, or undefined
 *   when it reported nothing (no file, a file that says off, or a malformed
 *   `ready` field the lenient parser dropped)
 */
export function decideSshEnabled(row: SshRow, reported: NodeSshEnabledWire | undefined): SshDecision {
  const rowOn = row.sshEnabled === 1;
  // Silence reads as OFF — the node's own fail-closed default — which is the
  // only reading under which "node lost its file while the row says off" is
  // the quiet agreement it is.
  if ((reported?.on ?? false) === rowOn) return "noop";
  // The one disagreement with nothing to send (rows: never-written row, node
  // mirror on). `decideMaintenance` had an `adopt-node` for this cell; here
  // the row is the record and an unstamped push would invent a write time.
  if (!row.sshEnabledAt) return "noop";
  return "push-plane";
}

/**
 * Send one node the SSH state the plane holds, so both copies end
 * byte-identical.
 *
 * `local` is skipped: the control-plane host has no agent socket and no
 * mirror file — its answer to the gate is the DB row itself, which is exactly
 * why the server account's SSH runs check the row and nothing else.
 *
 * @param nodeId - the node to tell; `local` is a no-op
 * @param state - the STORED value, relayed verbatim; never re-stamped here,
 *   or the relay would outrank the decision it is carrying
 */
export async function pushSetSshEnabled(nodeId: string, state: NodeSshEnabledWire): Promise<void> {
  if (nodeId === LOCAL_NODE_ID) return;
  await sendCommand(nodeId, { type: "set_ssh_enabled", on: state.on, changedAt: state.changedAt });
}

/**
 * {@link pushSetSshEnabled}, fire-and-forget with the failure logged — the
 * shape `pushSetMaintenanceBestEffort` established, for the same reasons.
 *
 * An offline node simply misses it: the flag is already on the plane's row,
 * which is what refuses every SSH act plane-side, and the node re-learns the
 * value on its next `ready` through {@link reconcileSshEnabled}. There is
 * nothing a caller could usefully await or retry.
 */
export function pushSetSshEnabledBestEffort(nodeId: string, state: NodeSshEnabledWire): void {
  void pushSetSshEnabled(nodeId, state).catch((err: unknown) => {
    logger
      .withError(err)
      .warn(`ssh-enabled push failed for node ${nodeId}; its mirror stays stale until it reconnects`);
  });
}

/**
 * Reconcile one node's report against the plane's row — the body of the
 * `onSshEnabled` lifecycle hook, fed by `ready.sshEnabled` and by the
 * `ssh_enabled` event a machine sends when its mirror moved underneath it.
 *
 * The whole hook is one read and at most one fire-and-forget push: there is
 * nothing to stop (an SSH flip kills no panes), nothing to write (the row
 * already stands), and nothing to await (a slow node must not hold the
 * socket's frame queue on a flag the row is already enforcing). A row that
 * disagrees with the machine pushes; a machine that disagrees with nothing
 * says nothing further. Never the other direction — that rule is the point.
 *
 * @param nodeId - the SOCKET's authenticated identity, never a frame's claim
 * @param reported - the machine's mirror answer, or undefined when it
 *   reported none
 */
export async function reconcileSshEnabled(nodeId: string, reported: NodeSshEnabledWire | undefined): Promise<void> {
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.findById(nodeId);
  if (!row) return;
  const stamp = row.sshEnabledAt;
  if (decideSshEnabled(row, reported) !== "push-plane" || stamp === null) return;
  // (`decideSshEnabled` only answers "push-plane" when a stamp exists; the
  // null check is what shows the type what the decide already proved.)
  pushSetSshEnabledBestEffort(nodeId, { on: row.sshEnabled === 1, changedAt: stamp });
}
