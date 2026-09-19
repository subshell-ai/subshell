import { apiFetch, apiPost, isAlreadyGone } from "@internal/node-admin";
import { useCallback } from "react";

/**
 * The pane-lifecycle endpoints of one workspace, shared by the two
 * presentations (`WorkspaceDock`, `WorkspaceTabs`), which used to spell the
 * same fetches — and the same 404-tolerant delete — side by side.
 *
 * These own the network calls only. The presentations differ in what a pane
 * means on screen (the dock adds/closes dockview panels between the calls;
 * the tab strip just re-selects), so each keeps its own sequencing around
 * these functions and its own error display.
 * @param workspaceId - The workspace whose panes are managed
 */
export function useWorkspacePaneMutations(workspaceId: string) {
  /** Attaches a subshell as a new pane row; resolves with the created row. */
  const addPane = useCallback(
    (subshellId: string) =>
      apiPost<{ id: string }>(`/api/workspaces/${workspaceId}/panes`, {
        subshellId,
      }),
    [workspaceId],
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
   * The server also reports whether removing this pane took the WORKSPACE
   * with it: an unsaved (draft) workspace left with fewer than two panes is
   * deleted, because a one-pane split is just the subshell it started from.
   * The caller navigates to a remaining subshell instead of closing a tile.
   * An already-gone pane answers `false` — there is no body to read, and a
   * draft this client already emptied would have navigated away then.
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
        return { workspaceDeleted: res.workspaceDeleted === true };
      } catch (err) {
        if (!isAlreadyGone(err)) throw err;
        return { workspaceDeleted: false };
      }
    },
    [workspaceId],
  );

  return { addPane, restartSubshell, removePane };
}
