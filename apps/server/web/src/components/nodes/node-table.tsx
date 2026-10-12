import type { Node } from "@internal/node-admin";
import { Badge, Card, CardContent, CardHeader, CardTitle, cn, relativeElapsed } from "@internal/node-admin";
import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { ActionsMenu } from "@/components/actions-menu";
import { nodeActions } from "@/components/nodes/node-actions";
import { osLabel } from "@/components/nodes/node-row";
import { useMaintenanceFlip } from "@/components/nodes/use-maintenance-flip";

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
  /** Delete this node (retire-gated server-side: owner or admin) */
  onDelete: () => void;
  /** Say something on the page's one message line; null clears it */
  onError: (message: string | null) => void;
}): JSX.Element {
  const onMaintenance = useMaintenanceFlip(node, onError);
  return (
    <tr className="border-b last:border-0">
      <td className="h-8 @sm:w-1/3 w-full max-w-0 py-0 pr-4">
        <div className="flex items-center gap-2">
          <span
            role="img"
            aria-label={node.status === "online" ? "Online" : "Offline"}
            title={node.status === "online" ? "Online" : "Offline"}
            className={cn("size-2 shrink-0 rounded-full", node.status === "online" ? "bg-success" : "bg-destructive")}
          />
          <Link
            to="/nodes/$id"
            params={{ id: node.id }}
            className="truncate font-strong hover:underline"
            title={node.name}
          >
            {node.name}
          </Link>
        </div>
        {node.maintenance && (
          <Badge variant="warning" className="mt-1">
            maintenance
          </Badge>
        )}
      </td>
      <td
        className="@lg:table-cell hidden h-8 max-w-0 truncate py-0 pr-4 text-muted-foreground"
        title={node.hostname ?? node.id}
      >
        {node.hostname ?? node.id}
      </td>
      <td className="@3xl:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
        {osLabel(node.os)}
        {node.arch ? ` · ${node.arch}` : ""}
      </td>
      <td
        className="@2xl:table-cell hidden h-8 max-w-0 truncate py-0 pr-4 text-muted-foreground"
        title={node.ownerLabel ?? (node.access === "owner" ? "You" : "—")}
      >
        {node.ownerLabel ?? (node.access === "owner" ? "You" : "—")}
      </td>
      <td className="@3xl:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
        {node.agentVersion ? `v${node.agentVersion}` : "—"}
      </td>
      <td className="@sm:table-cell hidden h-8 whitespace-nowrap py-0 pr-4 text-muted-foreground">
        {node.kind === "local" ? "—" : node.lastSeenAt ? relativeElapsed(node.lastSeenAt) : "never"}
      </td>
      <td className="h-8 w-px py-0 text-right">
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
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Nodes</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="@container overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pr-4 pb-2 font-strong">Name</th>
                <th className="@lg:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Host</th>
                <th className="@3xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Platform</th>
                <th className="@2xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Owner</th>
                <th className="@3xl:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Version</th>
                <th className="@sm:table-cell hidden whitespace-nowrap pr-4 pb-2 font-strong">Seen</th>
                <th className="pb-2 text-right font-strong" />
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
      </CardContent>
    </Card>
  );
}
