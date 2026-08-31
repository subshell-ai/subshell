import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SESSION_LOG_QUERY_KEY } from "@/lib/query-keys";

/** The tail of a session's pane log, as served by `GET /api/sessions/:id/log`. */
export interface SessionLogTail {
  /** Last captured lines, oldest first; empty when no log exists (yet) */
  lines: string[];
  /** True when older output existed but was cut from the response */
  truncated: boolean;
}

/**
 * Fetches a session's pane-log tail — the diagnostic record shown when the
 * harness has exited (a dead pane refuses WS attach and the live preview is
 * empty, so this file is the only witness of the error). Disabled until the
 * caller asks for it, i.e. while the terminal is attached there is nothing
 * to diagnose.
 */
export function useSessionLog(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...SESSION_LOG_QUERY_KEY, sessionId],
    queryFn: () => apiFetch<SessionLogTail>(`/api/sessions/${sessionId}/log`),
    enabled,
    // The file only grows while the harness lives; once it's dead the tail
    // never changes again, so a refetch is pointless within a view.
    staleTime: 30_000,
    retry: false,
  });
}
