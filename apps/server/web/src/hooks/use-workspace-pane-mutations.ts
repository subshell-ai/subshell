import { apiFetch, apiPost, isAlreadyGone } from "@internal/node-admin";
import { useCallback } from "react";
import { useInvalidateWorkspaces } from "@/hooks/use-workspaces";

/**
 * The pane-lifecycle endpoints of one workspace, shared by the two
 * presentations (`WorkspaceDock`, `WorkspaceTabs`) and by the rail's drop
 * target, which used to spell the same fetches — and the same 404-tolerant
 * delete — side by side.
 *
 * These own the network calls AND the cache wake that follows one: a pane
 * add/remove changes what the LIST carries (the rail's tree branches render
 * from it) and what the subshell page's workspace control reads, and the
 * presentations only refetch their own DETAIL. A surface that closed a tab
 * and refetched just the dock left the sidebar showing the removed pane
 * (operator bug, 2026-10-17) — the wake belongs to the mutation, so no
 * caller can forget it. The presentations still differ in what a pane means
 * on screen (the dock adds/closes dockview panels between the calls; the tab
 * strip just re-selects), so each keeps its own sequencing and its own error
 * display.
 * @param workspaceId - The workspace whose panes are managed
 */
export function useWorkspacePaneMutations(workspaceId: string) {
  const invalidate = useInvalidateWorkspaces();

  /** Attaches a subshell as a new pane row; resolves with the created row. */
  const addPane = useCallback(
    async (subshellId: string) => {
      const row = await apiPost<{ id: string }>(`/api/workspaces/${workspaceId}/panes`, {
        subshellId,
      });
      void invalidate();
      return row;
    },
    [workspaceId, invalidate],
  );

  /**
   * Restarts a subshell's process IN PLACE (same id). Deliberately does NOT
   * touch panes: because the id survives, the existing workspace_panes row
   * already references the revived subshell — the caller just refetches. (There
   * is no replacement pane to add and no old pane to drop; doing the old
   * clone-era swap now yields a duplicate pane for one subshell.)
   * @returns The restarted subshell — id === subshellId
   */
  const restartSubshell = useCallback(
    (subshellId: string) => apiFetch<{ id: string }>(`/api/subshells/${subshellId}/restart`, { method: "POST" }),
    [],
  );

  /**
   * Deletes a pane row. An already-gone failure (another client removed it,
   * or a subshell delete cascaded it away first) is the state this call was
   * trying to reach, so it resolves quietly — the caller still closes or
   * re-selects its pane either way. A genuine failure (5xx, network) throws
   * so the caller can surface it instead of pretending the pane is gone.
   *
   * Current servers refuse to remove the last pane (409). Keep reading the
   * legacy workspaceDeleted field for older servers that retire the workspace.
   * An already-gone pane answers false because there is no body to read.
   * @param paneId - The pane row to remove
   * @returns Whether the workspace itself was deleted along with the pane
   */
  const removePane = useCallback(
    async (paneId: string): Promise<{ workspaceDeleted: boolean }> => {
      try {
        const res = await apiFetch<{ ok: boolean; workspaceDeleted?: boolean }>(
          `/api/workspaces/${workspaceId}/panes/${paneId}`,
          { method: "DELETE" },
        );
        void invalidate();
        return { workspaceDeleted: res.workspaceDeleted === true };
      } catch (err) {
        if (!isAlreadyGone(err)) throw err;
        // Already gone means membership changed without us (a concurrent
        // close, a cascade) — exactly when the LIST this client holds is
        // the stale one.
        void invalidate();
        return { workspaceDeleted: false };
      }
    },
    [workspaceId, invalidate],
  );

  return { addPane, restartSubshell, removePane };
}
