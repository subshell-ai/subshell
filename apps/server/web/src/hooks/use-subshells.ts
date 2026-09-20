import { apiFetch } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * The one `GET /api/subshells` reader. `useSubshellsList` and `useSubshellRow`
 * are the same query with and without a selector; spelling the fetch twice is
 * how the two would drift (a header here, a different path there) while the
 * cache key stayed shared.
 */
export function fetchSubshellList(): Promise<SubshellView[]> {
  return apiFetch<SubshellView[]>("/api/subshells");
}

/**
 * The one definition of the full subshell-list query. The home page's REST
 * feed, the sidebar's recent-subshells sub-list, and the workspace dialog's
 * picker each used to spell the same `queryKey` + `queryFn` independently.
 */
export function useSubshellsList() {
  return useQuery({
    queryKey: SUBSHELLS_QUERY_KEY,
    queryFn: fetchSubshellList,
  });
}

/**
 * Invalidates the subshell list. Keeps the key in one place the way
 * `useInvalidatePresets` does, for every place subshells are created or
 * bulk-acted on.
 */
export function useInvalidateSubshells(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SUBSHELLS_QUERY_KEY });
}
