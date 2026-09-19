import { createFileRoute } from "@tanstack/react-router";
import { NodeLogCard } from "@/components/nodes/node-log-card";
import { NodePageShell } from "@/components/nodes/node-page-shell";

export const Route = createFileRoute("/nodes_/$id/logs")({ component: NodeLogsPage });

/**
 * One node's Logs section (spec 2026-09-12, node half § 4).
 *
 * The node writes one bounded file of its own precisely so this page can
 * exist on every platform: its console output goes to a file under launchd and
 * to the journal under systemd, and neither is something a browser can read.
 */
function NodeLogsPage() {
  const { id } = Route.useParams();
  return (
    <NodePageShell id={id}>
      {(node) =>
        node.status === "online" ? (
          <NodeLogCard node={node} />
        ) : (
          <p className="text-muted-foreground text-sm">
            This node is offline. Its log is read through the node's own connection, so it can only be read while the
            node is running.
          </p>
        )
      }
    </NodePageShell>
  );
}
