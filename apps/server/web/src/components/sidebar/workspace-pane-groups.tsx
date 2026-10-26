import { useNavigate } from "@tanstack/react-router";
import { ListLoadError } from "@/components/list-load-error";
import { NodeLaunchMenu } from "@/components/sidebar/node-launch-menu";
import { SidebarGroupHeading } from "@/components/sidebar/sidebar-group-heading";
import { SubshellTreeRow } from "@/components/sidebar/subshell-tree-row";
import { useNodes } from "@/hooks/use-nodes";
import { useSubshellsList } from "@/hooks/use-subshells";
import { groupSubshellsByNode } from "@/lib/subshell-node-groups";
import { subshellTree, workspaceSubshellIds } from "@/lib/subshell-tree";
import { armPaneFocusOnArrive, requestWorkspacePaneFocus } from "@/lib/workspace-focus";
import type { SubshellView } from "@/types/subshell";
import type { WorkspaceRow } from "@/types/workspace";

/** Group workspace members by machine, keeping spawned helpers beside their creator. */
export function WorkspacePaneGroups({
  workspace,
  focusedId,
  labelsFor,
  onAction,
}: {
  onAction?: () => void;
  workspace: WorkspaceRow;
  focusedId: string | null;
  labelsFor: (subshell: SubshellView) => { nodeLabel: string; agentLabel: string; presetLabel?: string };
}) {
  const results = useSubshellsList();
  const subshells = results.data ?? [];
  const { data: nodes } = useNodes();
  const navigate = useNavigate();
  const members = new Set(workspace.panes?.map((pane) => pane.subshellId));
  const visible = workspaceSubshellIds(subshells, members);
  const { roots, children } = subshellTree(subshells.filter((row) => visible.has(row.id)));
  // Keep the workspace's tab order within each machine group.
  const paneOrder = new Map((workspace.panes ?? []).map((pane, index) => [pane.subshellId, index]));
  roots.sort((a, b) => (paneOrder.get(a.id) ?? 0) - (paneOrder.get(b.id) ?? 0));
  const groups = groupSubshellsByNode(roots, nodes?.nodes, { unanswered: nodes === undefined });
  function open(subshell: SubshellView) {
    if (members.has(subshell.id)) {
      if (requestWorkspacePaneFocus(subshell.id, workspace.id)) return;
      armPaneFocusOnArrive(subshell.id);
      void navigate({ to: "/workspaces/$id", params: { id: workspace.id } });
    } else {
      void navigate({
        to: "/workspaces/$id",
        params: { id: workspace.id },
        search: { add: subshell.id, dir: "within" },
      });
    }
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.nodeId} aria-label={group.label}>
          <SidebarGroupHeading
            action={
              <NodeLaunchMenu node={nodes?.nodes?.find((node) => node.id === group.nodeId)} onAction={onAction} />
            }
          >
            {group.label}
          </SidebarGroupHeading>
          {group.subshells.map((subshell) => (
            <SubshellTreeRow
              key={subshell.id}
              subshell={subshell}
              childrenByParent={children}
              focusedId={focusedId}
              labelsFor={labelsFor}
              workspaceId={workspace.id}
              memberIds={members}
              onOpen={open}
            />
          ))}
        </section>
      ))}
      {results.isError ? (
        <ListLoadError message="Couldn’t load workspace subshells." retry={results.refetch} busy={results.isFetching} />
      ) : results.isLoading ? (
        <p className="px-3 py-1 text-detail text-muted-foreground">Loading workspace subshells…</p>
      ) : (workspace.panes ?? []).some((pane) => !subshells.some((row) => row.id === pane.subshellId)) ? (
        <p className="px-3 py-1 text-detail text-muted-foreground">Some workspace subshells are unavailable.</p>
      ) : null}
    </>
  );
}
