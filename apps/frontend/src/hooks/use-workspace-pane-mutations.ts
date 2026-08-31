import { useCallback } from "react";
import { apiFetch, apiPost, isAlreadyGone } from "@/lib/api";

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
  /** Attaches a session as a new pane row; resolves with the created row. */
  const addPane = useCallback(
    (sessionId: string) =>
      apiPost<{ id: string }>(`/api/workspaces/${workspaceId}/panes`, {
        sessionId,
      }),
    [workspaceId],
  );

  /**
   * Restarts a session's process IN PLACE (same id). Deliberately does NOT
   * touch panes: because the id survives, the existing workspace_panes row
   * already references the revived session — the caller just refetches. (There
   * is no replacement pane to add and no old pane to drop; doing the old
   * clone-era swap now yields a duplicate pane for one session.)
   * @returns The restarted session — id === sessionId
   */
  const restartSession = useCallback(
    (sessionId: string) => apiFetch<{ id: string }>(`/api/sessions/${sessionId}/restart`, { method: "POST" }),
    [],
  );

  /**
   * Deletes a pane row. An already-gone failure (another client removed it,
   * or a session delete cascaded it away first) is the state this call was
   * trying to reach, so it resolves quietly — the caller still closes or
   * re-selects its pane either way. A genuine failure (5xx, network) throws
   * so the caller can surface it instead of pretending the pane is gone.
   * @param paneId - The pane row to remove
   */
  const removePane = useCallback(
    async (paneId: string): Promise<void> => {
      try {
        await apiFetch(`/api/workspaces/${workspaceId}/panes/${paneId}`, { method: "DELETE" });
      } catch (err) {
        if (!isAlreadyGone(err)) throw err;
      }
    },
    [workspaceId],
  );

  return { addPane, restartSession, removePane };
}
