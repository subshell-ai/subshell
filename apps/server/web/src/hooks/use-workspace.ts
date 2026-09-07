import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceDetail } from "@/types/workspace";

/**
 * One workspace with its panes.
 *
 * Polled on a fixed interval so panes notice their subshells exiting.
 */
export function useWorkspace(id: string) {
  return useQuery({
    queryKey: [...WORKSPACE_QUERY_KEY, id],
    queryFn: () => apiFetch<WorkspaceDetail>(`/api/workspaces/${id}`),
    refetchInterval: 5000,
  });
}
