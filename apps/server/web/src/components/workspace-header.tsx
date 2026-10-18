import { apiFetch } from "@internal/node-admin";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { EditableText } from "@/components/editable-text";
import { SubshellActionsMenu } from "@/components/subshell-actions-menu";
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer";
import { usePaneCopyMode } from "@/hooks/use-pane-copy-mode";
import { useSubshellRow } from "@/hooks/use-subshell-row";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import { useWorkspaceFocusedId } from "@/lib/workspace-focus";
import type { WorkspacePaneRow, WorkspaceRow } from "@/types/workspace";

/** Reuse the ordinary subshell actions and keep dialogs bound to this pane. */
function FocusedPaneActions({ id }: { id: string }) {
  const subshell = useSubshellRow(id);
  const copyMode = usePaneCopyMode(id);
  const coarse = useIsCoarsePointer();
  return subshell ? <SubshellActionsMenu subshell={subshell} copyMode={coarse ? copyMode : undefined} /> : null;
}

/**
 * The bar above a workspace: back link, name, and the workspace-level
 * actions on the right.
 *
 * Rendered by each presentation rather than by the route, because `actions`
 * is the add-a-pane control and only the presentation knows how to add a
 * pane — the dock splits, the tab strip appends. Sharing the bar itself
 * keeps the two from drifting apart.
 *
 * The name edits in place (click it): the bar owns the PUT and the refresh,
 * so both presentations get editing without knowing anything about it. The
 * open detail page re-reads from the `["workspace", id]` query this updates;
 * the list page's cards re-read from the shared list query.
 *
 * There is no saved/unsaved split (spec 2026-10-17): every workspace is a
 * real one the moment it has a tab, retires itself when it loses the last,
 * and carries a name from birth — auto-chosen, but renameable like any
 * other.
 */
export function WorkspaceHeader({
  workspace,
  actions,
  panes = [],
}: {
  workspace: WorkspaceRow;
  /** Current panes constrain the global focus to this workspace. */
  panes?: WorkspacePaneRow[];
  /** Workspace-level controls, right-aligned. */
  actions?: ReactNode;
}): JSX.Element {
  const focusedId = useWorkspaceFocusedId();
  const focusedPane = panes.find((pane) => pane.subshellId === focusedId);
  const paneActions = focusedPane ? (
    <FocusedPaneActions key={focusedPane.subshellId} id={focusedPane.subshellId} />
  ) : null;
  const queryClient = useQueryClient();
  const invalidateWorkspaces = useInvalidateWorkspaces();

  const rename = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/api/workspaces/${workspace.id}`, { method: "PUT", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...WORKSPACE_QUERY_KEY, workspace.id] });
      void invalidateWorkspaces();
    },
  });

  async function saveName(name: string): Promise<void> {
    try {
      await rename.mutateAsync(name);
    } catch (err) {
      // Names are no longer unique, so a 409 here would be a stale server
      // enforcing the retired index; say what it is rather than blame the
      // name. Same posture as the split's stale-server readings.
      const message = err instanceof Error ? err.message : "";
      throw new Error(
        message.includes("409")
          ? "Your server still treats workspace names as unique; update it."
          : message || "Failed to save",
      );
    }
  }

  return (
    <DetailBackHeader
      to="/workspaces"
      backLabel="Back to workspaces"
      title={
        <EditableText
          value={workspace.name}
          label="Rename workspace"
          onSave={saveName}
          className="min-w-0 font-strong"
          inputClassName="w-56"
        />
      }
      actions={
        <>
          {paneActions}
          {actions}
        </>
      }
    />
  );
}
