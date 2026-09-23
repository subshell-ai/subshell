import type { Node } from "@internal/node-admin";
import { Badge, relativeElapsed } from "@internal/node-admin";
import type { JSX } from "react";
import { ActionsMenu } from "@/components/actions-menu";
import { nodeActions } from "@/components/nodes/node-actions";
import { osLabel } from "@/components/nodes/node-row";
import { useMaintenanceFlip } from "@/components/nodes/use-maintenance-flip";

/**
 * The Nodes list as a table — the second view of the same rows, chosen by the
 * page's tab group (operator's ask, 2026-09-22). The card row (`NodeListRow`)
 * is the scan-a-few-at-a-time view with its harness chips and full second
 * line; this is the fleet-at-a-glance view where the columns line up across
 * machines and the questions are the same for every row: name, host, what it
 * runs, whether it is up, and which node CLI is on it.
 *
 * The columns carry the SAME server-derived facts the card reads — nothing
 * re-derived here — and deliberately drop the per-harness chips (that is the
 * card's job; a fixed grid cannot grow a variable-length middle the way the
 * card's wrapping column does). The `maintenance` warning is NOT dropped: a
 * machine in maintenance reads entirely online otherwise, and a status the
 * table hides is a status that surprises someone when a launch fails.
 */

/** One table row, with the maintenance flip bound to it. */
function NodeTableRow({
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
  /** Say something on the page's one message line; null clears it */
  onError: (message: string | null) => void;
}): JSX.Element {
  const onMaintenance = useMaintenanceFlip(node, onError);
  return (
    <tr className="border-b last:border-0">
      <td className="max-w-[16rem] py-2 pr-4">
        <p className="truncate font-strong">{node.name}</p>
      </td>
      <td className="py-2 pr-4 text-detail text-muted-foreground">{node.hostname ?? node.id}</td>
      <td className="py-2 pr-4 text-detail text-muted-foreground">
        {osLabel(node.os)}
        {node.arch ? ` · ${node.arch}` : ""}
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2">
          <Badge variant={node.status === "online" ? "success" : "muted"}>{node.status}</Badge>
          {node.maintenance && <Badge variant="warning">maintenance</Badge>}
        </div>
      </td>
      <td className="py-2 pr-4 text-detail text-muted-foreground">
        {node.agentVersion ? `v${node.agentVersion}` : "—"}
      </td>
      <td className="py-2 pr-4 text-detail text-muted-foreground">
        {node.lastSeenAt ? relativeElapsed(node.lastSeenAt) : "never"}
      </td>
      <td className="py-2 text-right">
        <ActionsMenu label={node.name} items={nodeActions(node, { onOpenConfig, onShare, onMaintenance, onDelete })} />
      </td>
    </tr>
  );
}

/** The whole Nodes table: header plus one row per node. */
export function NodeTable({
  nodes,
  onOpenConfig,
  onShare,
  onDelete,
  onError,
}: {
  /** The nodes to list, already in the server's order */
  nodes: Node[];
  /** Open a node's config page */
  onOpenConfig: (id: string) => void;
  /** Open a node's sharing management */
  onShare: (id: string) => void;
  /** Delete a node */
  onDelete: (node: Node) => void;
  /** Say something on the page's one message line */
  onError: (message: string | null) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pr-4 pb-2 font-strong">Name</th>
            <th className="pr-4 pb-2 font-strong">Host</th>
            <th className="pr-4 pb-2 font-strong">Platform</th>
            <th className="pr-4 pb-2 font-strong">Status</th>
            <th className="pr-4 pb-2 font-strong">Agent</th>
            <th className="pr-4 pb-2 font-strong">Seen</th>
            <th className="pb-2 text-right font-strong">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <NodeTableRow
              key={node.id}
              node={node}
              onOpenConfig={() => onOpenConfig(node.id)}
              onShare={() => onShare(node.id)}
              onDelete={() => onDelete(node)}
              onError={onError}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
