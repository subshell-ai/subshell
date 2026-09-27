import { apiFetch } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SUBSHELL_WORKSPACES_QUERY_KEY, WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/** Query key for the caller's workspaces, shared by every mutation site. */
export const WORKSPACES_QUERY_KEY = ["workspaces"] as const;

/** Shared query for the caller's workspaces. */
export function useWorkspaces() {
  return useQuery({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces"),
  });
}

/**
 * The caller's UNSAVED draft workspaces, for the sidebar's "Drafts" section. A
 * child of the workspaces key, so the shared invalidator refreshes it with the
 * list. Kept separate from `useWorkspaces` because the Workspaces PAGE wants the
 * default (saved-only) read and must not start seeing drafts.
 */
export function useDraftWorkspaces() {
  return useQuery({
    queryKey: [...WORKSPACES_QUERY_KEY, "drafts"],
    queryFn: () => apiFetch<WorkspaceRow[]>("/api/workspaces?drafts=only"),
  });
}

/**
 * Invalidates the workspace list AND every per-subshell membership query
 * (`useSubshellWorkspaces`). Both read the same table, and every act that
 * changes it — create, promote, discard, the auto-discard of a thin draft —
 * already calls this, so one invalidator keeps the subshell page's "Open
 * unsaved workspace" link from outliving the draft it points at.
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
      // subshell page's earlier half of the same bug).
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
    ]);
  };
}
