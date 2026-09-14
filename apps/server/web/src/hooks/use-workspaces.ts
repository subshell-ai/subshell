import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SUBSHELL_WORKSPACES_QUERY_KEY } from "@/lib/query-keys";
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
    ]);
  };
}
