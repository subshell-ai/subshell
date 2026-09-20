import { apiFetch } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { SUBSHELL_WORKSPACES_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * The caller's workspaces holding a pane for one subshell, newest update
 * first — `GET /api/workspaces?subshellId=` (spec 2026-09-14 §2).
 *
 * The only read that returns DRAFTS: the plain list excludes them, because a
 * draft is not something to browse to. Here it is exactly what the subshell
 * page wants to offer — "you already split this one, go back to it".
 *
 * `staleTime` is 30 s rather than 0 because the answer changes only when this
 * viewer splits or discards, and both of those invalidate this key directly;
 * a header link is not worth a request per focus.
 * @param subshellId - The subshell whose workspaces to list
 */
export function useSubshellWorkspaces(subshellId: string) {
  return useQuery({
    queryKey: [...SUBSHELL_WORKSPACES_QUERY_KEY, subshellId],
    queryFn: () => apiFetch<WorkspaceRow[]>(`/api/workspaces?subshellId=${encodeURIComponent(subshellId)}`),
    staleTime: 30_000,
  });
}
