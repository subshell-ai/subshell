import type { Node } from "@internal/node-admin";
import type { JSX } from "react";
import { NodeRow } from "@/components/nodes/node-row";
import { useMaintenanceFlip } from "@/components/nodes/use-maintenance-flip";

/**
 * One CARD row of the Nodes list: `NodeRow` with the maintenance flip bound
 * to it.
 *
 * `NodeRow` stays presentation — entity knowledge belongs to the caller, the
 * rule `ActionsMenu` states — but this one action cannot live on the page
 * either: the flip is a hook keyed by THIS row's id, and a hook cannot be
 * called inside a `map`. One container per row is what React gives for that.
 * The flip itself (the count fetch, the confirmation, the cache fallout) is
 * `useMaintenanceFlip`, shared with the table row so both views ask the same
 * question the same way.
 */
export function NodeListRow({
  node,
  onOpenConfig,
  onShare,
  onDelete,
  onError,
}: {
  /** The node this row renders */
  node: Node;
  /** Open this node's config page */
  onOpenConfig: () => void;
  /** Open this node's sharing management (owner-only server-side) */
  onShare: () => void;
  /** Delete this node (owner-only server-side) */
  onDelete: () => void;
  /**
   * Say something on the page's one message line; null clears it.
   *
   * Two things travel here, and both have to: the server's refusal, and a flip
   * that LANDED while the node refused to kill some of what was running on it.
   * The second reads as a success everywhere else on this row — the badge
   * flips, the menu item changes — so dropping it tells someone a machine is
   * quiet when panes are still alive there.
   */
  onError: (message: string | null) => void;
}): JSX.Element {
  const onMaintenance = useMaintenanceFlip(node, onError);
  return (
    <NodeRow
      node={node}
      onOpenConfig={onOpenConfig}
      onShare={onShare}
      onDelete={onDelete}
      onMaintenance={onMaintenance}
    />
  );
}
