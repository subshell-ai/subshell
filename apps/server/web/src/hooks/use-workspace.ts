import { apiFetch } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { WORKSPACE_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceDetail } from "@/types/workspace";

/**
 * One workspace with its panes.
 *
 * NOT polled. A pane noticing its subshell exit was the only reason for the
 * 5 s interval here, and that now arrives on the live socket as a change to
 * the subshell row (spec 2026-09-19). What this query answers — which panes a
 * workspace has, and their layout — changes only by an act on this page,
 * and every one of those writes back or invalidates.
 */
export function useWorkspace(id: string) {
  return useQuery({
    queryKey: [...WORKSPACE_QUERY_KEY, id],
    queryFn: () => apiFetch<WorkspaceDetail>(`/api/workspaces/${id}`),
  });
}
