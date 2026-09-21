import { NodeAllowedDirs, NodeServerUrlCard } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DirectoryPickerInput } from "@/components/directory-picker-input";
import { NodePageShell } from "@/components/nodes/node-page-shell";
import { managesNodeConfig } from "@/components/nodes/node-section-nav";

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
      {(node) =>
        managesNodeConfig(node) ? (
          <>
            {/* Repointing is a DAEMON concept — the control-plane host is the
                server, there is no URL for it to dial. Its Configuration tab
                holds the one rule that applies to it: the launch allowlist. */}
            {node.kind !== "local" && <NodeServerUrlCard node={node} />}
            {/* The picker is passed IN because the folder browser is a
                control-plane thing (it walks this server's file API); the
                shared card works wherever the editor is absent — which is
                exactly the node's own dashboard, where the list is read-only. */}
            <NodeAllowedDirs
              node={node}
              renderEditor={(args) => (
                <DirectoryPickerInput
                  value={args.value}
                  onChange={args.onChange}
                  nodeId={node.id}
                  nodeName={node.name}
                  placeholder={args.placeholder}
                />
              )}
              // The folder picker's listings are scoped by these rules, so a
              // change makes every cached explore response stale.
              onDirsSaved={() => {
                void queryClient.invalidateQueries({ queryKey: ["explore"] });
                void queryClient.invalidateQueries({ queryKey: ["recent-paths"] });
              }}
            />
          </>
        ) : (
          // Same rule as the nav (`managesNodeConfig`): a `view` grantee and
          // a non-admin viewer of the host get the Overview, not cards whose
          // routes refuse them.
          <Navigate to="/nodes/$id" params={{ id: node.id }} replace />
        )
      }
    </NodePageShell>
  );
}
