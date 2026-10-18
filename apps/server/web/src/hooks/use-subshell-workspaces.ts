import { apiFetch } from "@internal/node-admin";
import { useQuery } from "@tanstack/react-query";
import { SUBSHELL_WORKSPACES_QUERY_KEY } from "@/lib/query-keys";
import type { WorkspaceRow } from "@/types/workspace";

/**
 * The caller's workspaces holding a pane for one subshell, newest update
 * first — `GET /api/workspaces?subshellId=` (spec 2026-09-14 §2).
 *
 * Ordered by recency, unlike the plain list's name order: the subshell page
 * wants "the arrangement you touched last" at the top of its menu. Drafts are
 * gone with migration 0058, so this read and the list see the same universe.
 *
 * `staleTime` is 30 s rather than 0 because the answer changes only when this
 * viewer files or removes a pane, and those acts invalidate this key directly;
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
