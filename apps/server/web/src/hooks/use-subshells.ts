import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * The one definition of the full subshell-list query. The home page's REST
 * feed, the sidebar's recent-subshells sub-list, and the workspace dialog's
 * picker each used to spell the same `queryKey` + `queryFn` independently.
 */
export function useSubshellsList() {
  return useQuery({
    queryKey: SUBSHELLS_QUERY_KEY,
    queryFn: () => apiFetch<SubshellView[]>("/api/subshells"),
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
