import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { NodeAllowedDirs, NodeServerUrlCard } from "@internal/node-admin";
import { DirectoryPickerInput } from "@/components/directory-picker-input";
import { NodePageShell } from "@/components/nodes/node-page-shell";

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
  const queryClient = useQueryClient();
  return (
    <NodePageShell id={id}>
      {(node) => (
        <>
          <NodeServerUrlCard node={node} />
          {/* The picker is passed IN because the folder browser is a
              control-plane thing (it walks this server's file API); the
              shared card works wherever the editor is absent — which is
              exactly the node's own dashboard, where the list is read-only. */}
          <NodeAllowedDirs
            node={node}
            renderEditor={(args) => (
              <DirectoryPickerInput value={args.value} onChange={args.onChange} nodeId={node.id} nodeName={node.name} placeholder={args.placeholder} />
            )}
            // The folder picker's listings are scoped by these rules, so a
            // change makes every cached explore response stale.
            onDirsSaved={() => {
              void queryClient.invalidateQueries({ queryKey: ["explore"] });
              void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
            }}
          />
        </>
      )}
    </NodePageShell>
  );
}
