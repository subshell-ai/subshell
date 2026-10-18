import { apiFetch } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SUBSHELL_WORKSPACES_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/** Query key for the caller's workspaces, shared by every mutation site. */
export const WORKSPACES_QUERY_KEY = ["workspaces"] as const;

/**
 * Shared query for the caller's workspaces. Since spec 2026-10-17 each row
 * carries its panes, so the rail tree branches render from this one request.
 * The draft machinery (`?drafts=only`, the separate drafts read) left with the
 * column: a workspace exists exactly as long as it holds a tab.
 */
export function useWorkspaces() {
  return useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces"),
  });
}

/**
 * Invalidates the workspace list AND every per-subshell membership query
 * (`useSubshellWorkspaces`). Both read the same table, and every act that
 * changes it — create, rename, pane moves, the empty self-retire — already
 * calls this, so one invalidator keeps the subshell page's workspace link
 * from outliving a workspace it points at.
 */
export function useInvalidateWorkspaces(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: SUBSHELL_WORKSPACES_QUERY_KEY }),
      // And the OPEN detail: a Delete from the rail (or any other surface)
      // must reach the page standing on that workspace — the detail query is
      // what it renders, and nothing else re-reads it (operator bug
      // 2026-09-27: deleting the workspace you are standing in left the
      // page rendering the dead one's cached detail forever, exactly the
      // subshell page's earlier half of the same bug). The empty self-retire
      // makes this even less optional: closing the last tab from anywhere
      // deletes the row the page is standing on.
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
    ]);
  };
}
