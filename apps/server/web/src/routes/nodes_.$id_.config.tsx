import { createFileRoute } from "@tanstack/react-router";
import { NodeAllowedDirs } from "@/components/nodes/node-allowed-dirs";
import { NodePageShell } from "@/components/nodes/node-page-shell";
import { NodeServerUrlCard } from "@/components/nodes/node-server-url-card";

export const Route = createFileRoute("/nodes_/$id_/config")({ component: NodeConfigPage });

/**
 * One node's Configuration section (spec 2026-09-12, node half § 2): the two
 * rules that decide where this machine points and what may run on it.
 *
 * The directory allowlist moved here from the Overview, where it sat beside
 * facts about the machine — it is a rule an owner revisits, which is what this
 * section is for.
 */
function NodeConfigPage() {
  const { id } = Route.useParams();
  return (
    <NodePageShell id={id}>
      {(node) => (
        <>
          <NodeServerUrlCard node={node} />
          <NodeAllowedDirs node={node} />
        </>
      )}
    </NodePageShell>
  );
}
