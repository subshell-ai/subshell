import type { NodePreviewEnabledWire } from "@internal/subshell-protocol";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { audit } from "@/services/audit.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * The per-node preview switch (pane-preview spec Task 3), written in exactly
 * one place: the posture `ssh-enabled.ts` established, cloned because the
 * two flags share more than a name: both gate something that exposes content,
 * both are opt-in per machine, and both mirror a file the plane alone writes.
 *
 * **The plane is the SOLE writer.** Same fact, same consequences: there is
 * no `subshell preview-enabled` verb, no second stamp to race, and
 * reconciliation never compares dates, never adopts, and answers every
 * disagreement the same way: push the row. The differences from the SSH twin
 * are what does NOT happen here: no relay broker to close (preview's lanes
 * land in later tasks) and no wide-forwards cousin.
 */

/**
 * Read the switch the way every gate reads it: the row is the record, read
 * fail-CLOSED. A row that does not exist, a column that was never flipped,
 * and a stamp-less default all answer OFF. Watching panes is opt-in, so an
 * unknown node is a refused node, never an error the caller must handle.
 */
export async function getWebPreviewsEnabled(nodeId: string): Promise<boolean> {
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.findById(nodeId);
  return row?.webPreviewsEnabled === 1;
}

export async function getVirtualDisplayEnabled(nodeId: string): Promise<boolean> {
  const { repos } = getRequestlessContext();
  return (await repos.nodes.findById(nodeId))?.virtualDisplayEnabled === 1;
}

/** The transport is available when either independently authorized feature needs it. */
export async function getAnyPreviewEnabled(nodeId: string): Promise<boolean> {
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.findById(nodeId);
  return row?.webPreviewsEnabled === 1 || row?.virtualDisplayEnabled === 1;
}

function previewWire(row: PreviewRow, changedAt: string): NodePreviewEnabledWire {
  const webPreviewsOn = row.webPreviewsEnabled === 1;
  const displayOn = row.virtualDisplayEnabled === 1;
  return {
    on: webPreviewsOn || displayOn,
    changedAt,
    ...(webPreviewsOn === displayOn ? {} : { webPreviewsOn, displayOn }),
  };
}

/** Flip one node's preview switch: row, audit, and the best-effort push,
 * all in this one function, so no caller can perform half the act. The
 * stamp is minted HERE (one change-site mints once); the route supplies the
 * acting human, never a time. */
export async function setPreviewEnabled(
  nodeId: string,
  actorUserId: string,
  on: boolean,
  feature: "web-previews" | "display" = "web-previews",
): Promise<void> {
  const changedAt = new Date().toISOString();
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.setPreviewEnabled(nodeId, { on, changedAt, feature });
  await audit({
    actorUserId,
    action: "node.preview_enabled.update",
    targetType: "node",
    targetId: nodeId,
    metadataJson: JSON.stringify({ on, feature }),
  });
  // The row is written and audited BEFORE the push, so a node that answers the
  // command cannot be looking at a mirror the record has not caught up to,
  // and a push that fails (the node is offline) costs nothing: the value
  // re-lands at the node's next `ready` through {@link reconcilePreviewEnabled}.
  if (row) pushSetPreviewEnabledBestEffort(nodeId, previewWire(row, changedAt));
}

/** The node-row fields {@link decidePreviewEnabled} reads. Nothing else is relevant. */
type PreviewRow = Pick<NodeTable, "webPreviewsEnabled" | "previewEnabledAt"> &
  Partial<Pick<NodeTable, "virtualDisplayEnabled">>;

/** What reconciliation decided about one node's two copies of the flag. */
export type PreviewDecision = "push-plane" | "noop";

/**
 * Decide what to do when the plane's row and the node's report disagree.
 * PURE: it reads two values and answers; the caller performs. Cloned from
 * `decideSshEnabled` verbatim in the one rule that matters: the plane is
 * authoritative, so stamps are never read and NOTHING adopts.
 *
 * | node reports | plane row | → |
 * |---|---|---|
 * | nothing | off / never written | `noop`: silence means refusal HERE, and the row already refuses |
 * | nothing | on | `push-plane`: the node has no file (or a lost one); give it ours |
 * | the row's value | any value | `noop`: agreement, the steady state; a push here would echo forever |
 * | the other value | with a stamp | `push-plane`: the row is the record; the machine is told, never asked |
 * | the other value | never written | `noop`: nothing to send (no stamp exists), and the disagreement is INERT: every plane-side gate reads the row, so a stale mirror-on permits nothing the row permits |
 *
 * @param row - the plane's node row (the two preview fields only)
 * @param reported - what the machine says its mirror answers, or undefined
 *   when it reported nothing (no file, a file that says off, or a malformed
 *   `ready` field the lenient parser dropped)
 */
export function decidePreviewEnabled(row: PreviewRow, reported: NodePreviewEnabledWire | undefined): PreviewDecision {
  const rowOn = row.webPreviewsEnabled === 1;
  const displayOn = row.virtualDisplayEnabled === 1;
  // Silence reads as OFF, the node's own fail-closed default, which is the
  // only reading under which "node lost its file while the row says off" is
  // the quiet agreement it is.
  if (
    (reported?.on ?? false) === (rowOn || displayOn) &&
    (reported?.webPreviewsOn ?? reported?.on ?? false) === rowOn &&
    (reported?.displayOn ?? reported?.on ?? false) === displayOn
  )
    return "noop";
  // The one disagreement with nothing to send (row never written, node mirror
  // on). The row IS off and the plane gates on the row, so an unstamped push
  // would only mint a write time for a write that never happened.
  if (!row.previewEnabledAt) return "noop";
  return "push-plane";
}

/**
 * Send one node the preview state the plane holds, so both copies end
 * byte-identical.
 *
 * `local` is skipped: the control-plane host has no agent socket and no
 * mirror file: its answer to the gate is the DB row itself.
 *
 * @param nodeId - the node to tell; `local` is a no-op
 * @param state - the STORED value, relayed verbatim; never re-stamped here,
 *   or the relay would outrank the decision it is carrying
 */
export async function pushSetPreviewEnabled(nodeId: string, state: NodePreviewEnabledWire): Promise<void> {
  if (nodeId === LOCAL_NODE_ID) return;
  await sendCommand(nodeId, { type: "set_preview_enabled", ...state });
}

/**
 * {@link pushSetPreviewEnabled}, fire-and-forget with the failure logged.
 *
 * An offline node simply misses it: the flag is already on the plane's row,
 * which is what refuses every preview act plane-side, and the node re-learns
 * the value on its next `ready` through {@link reconcilePreviewEnabled}.
 */
export function pushSetPreviewEnabledBestEffort(nodeId: string, state: NodePreviewEnabledWire): void {
  void pushSetPreviewEnabled(nodeId, state).catch((err: unknown) => {
    logger
      .withError(err)
      .warn(`preview-enabled push failed for node ${nodeId}; its mirror stays stale until it reconnects`);
  });
}

/**
 * Reconcile one node's report against the plane's row. Body of the
 * `onPreviewEnabled` lifecycle hook, fed by `ready.previewEnabled` and by the
 * `preview_enabled` event a machine sends when its mirror moved underneath it.
 *
 * The whole hook is one read and at most one fire-and-forget push: nothing to
 * stop (a preview flip closes no panes here; the lanes that could arrive in
 * later tasks own their own cuts), nothing to write, nothing to await. A row
 * that disagrees with the machine pushes; never the other direction. That
 * rule is the point.
 *
 * @param nodeId - the SOCKET's authenticated identity, never a frame's claim
 * @param reported - the machine's mirror answer, or undefined when it
 *   reported none
 */
export async function reconcilePreviewEnabled(
  nodeId: string,
  reported: NodePreviewEnabledWire | undefined,
): Promise<void> {
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.findById(nodeId);
  if (!row) return;
  const stamp = row.previewEnabledAt;
  if (decidePreviewEnabled(row, reported) !== "push-plane" || stamp === null) return;
  // (`decidePreviewEnabled` only answers "push-plane" when a stamp exists; the
  // null check is what shows the type what the decide already proved.)
  pushSetPreviewEnabledBestEffort(nodeId, previewWire(row, stamp));
}
