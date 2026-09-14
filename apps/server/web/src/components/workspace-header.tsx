import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { DetailBackHeader } from "@/components/detail-back-header";
import { EditableText } from "@/components/editable-text";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";
import { apiFetch } from "@/lib/api";
import { WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

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
 */
export function WorkspaceHeader({
  workspace,
  actions,
}: {
  workspace: WorkspaceRow;
  /** Workspace-level controls, right-aligned. */
  actions?: ReactNode;
}): JSX.Element {
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

  /** Re-label the duplicate-name 409 with something a human can act on. */
  async function saveName(name: string): Promise<void> {
    try {
      await rename.mutateAsync(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      throw new Error(
        message.includes("409") ? "You already have a workspace with that name" : message || "Failed to save",
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
      actions={actions}
    />
  );
}
