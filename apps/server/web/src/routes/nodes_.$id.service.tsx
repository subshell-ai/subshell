import { createFileRoute } from "@tanstack/react-router";
import { NodePageShell } from "@/components/nodes/node-page-shell";
import { NodeRuntimeCard } from "@/components/nodes/node-runtime-card";
import { NodeServiceCard } from "@/components/nodes/node-service-card";

export const Route = createFileRoute("/nodes_/$id/service")({ component: NodeServicePage });

/**
 * One node's Service section (spec 2026-09-12, node half § 2) — the mirror of
 * `/settings/service` for a machine that is not this one.
 *
 * For a HEADLESS node this is the only surface that answers any of it: who
 * supervises the node, since when, where it writes, and the five verbs that
 * act on the process. Both cards render themselves away without a runtime
 * report, which is also the access rule — the server attaches one only for an
 * online agent node whose viewer can configure it.
 */
function NodeServicePage() {
  const { id } = Route.useParams();
  return (
    <NodePageShell id={id}>
      {(node) => (
        <>
          <NodeRuntimeCard node={node} />
          <NodeServiceCard node={node} />
          {!node.runtime && (
            <p className="text-muted-foreground text-sm">
              {node.status === "online"
                ? "This node did not report how it runs."
                : "This node is offline, so there is nothing to report and nothing to drive. These facts describe a running process — offline, they would be stale by definition."}
            </p>
          )}
        </>
      )}
    </NodePageShell>
  );
}
