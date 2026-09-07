import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
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
 * Invalidates the workspace list. Keeps the key in one place the way
 * `use-workspaces` does, for every place workspaces are created or deleted.
 */
export function useInvalidateWorkspaces(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
}
