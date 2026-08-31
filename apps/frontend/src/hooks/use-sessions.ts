import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SESSIONS_QUERY_KEY } from "@/lib/query-keys";
import type { SessionView } from "@/types/session";

/**
 * The one definition of the full session-list query. The home page's REST
 * feed, the sidebar's recent-sessions sub-list, and the workspace dialog's
 * picker each used to spell the same `queryKey` + `queryFn` independently.
 */
export function useSessionsList() {
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => apiFetch<SessionView[]>("/api/sessions"),
  });
}

/**
 * Invalidates the session list. Keeps the key in one place the way
 * `useInvalidateProfiles` does, for every place sessions are created or
 * bulk-acted on.
 */
export function useInvalidateSessions(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
}
