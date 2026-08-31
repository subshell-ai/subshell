import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isSessionDead, isSessionExited } from "@/components/session-terminal";
import { apiFetch } from "@/lib/api";
import { SESSION_QUERY_KEY, SESSIONS_QUERY_KEY } from "@/lib/query-keys";
import type { SessionView } from "@/types/session";

/** Everything the session page reads about the session it is showing. */
export interface SessionData {
  /** The session being viewed (undefined while it loads, or if it is gone) */
  session: SessionView | undefined;
  /** True when the harness process has died while the record still says running */
  exited: boolean;
  /** True for either dead-but-kept shape: crashed-while-managed or terminated */
  dead: boolean;
}

/**
 * Loads one session, keeping it fresh while it can still change.
 * @param id - The session being viewed
 * @returns The session and the derived exited/dead flags
 */
export function useSessionData(id: string): SessionData {
  const queryClient = useQueryClient();

  const { data: session } = useQuery({
    queryKey: [...SESSION_QUERY_KEY, id],
    queryFn: () => apiFetch<SessionView>(`/api/sessions/${id}`),
  });

  const exited = isSessionExited(session);
  const dead = isSessionDead(session);

  // ALIVE & TERMINATED sessions: poll every few seconds so the exited state /
  // restart-pending indicator catch a process death without waiting for the
  // next SSE heartbeat (the WS can also appear connected, so it cannot be
  // relied on here). The list invalidation keeps the sidebar's recent-sessions
  // sub-list honest. Exited or terminated sessions no longer change; their
  // data is read from the single fetch above.
  useEffect(() => {
    if (dead) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: [...SESSION_QUERY_KEY, id] });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    }, 5000);
    return () => clearInterval(timer);
  }, [dead, id, queryClient]);

  return { session, exited, dead };
}
