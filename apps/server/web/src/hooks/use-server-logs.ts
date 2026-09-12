import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { SERVER_DEPLOYMENT_QUERY_KEY, SERVER_LOGS_QUERY_KEY } from "@/lib/query-keys";
import type { ServerDeployment, ServerLogs } from "@/types/server-deployment";

/** Lines the Server log card asks for, and the route's own default. */
export const SERVER_LOG_DEFAULT_LINES = 200;

/**
 * The tail of the server's own log file (`GET /api/admin/server/logs`).
 *
 * The file is capped at 200 KB and replaced when full, so this is never a
 * history — it is the recent past, which is what a person looking at a server
 * that just misbehaved needs. Five seconds is fast enough to watch a restart
 * land and slow enough that the route is in the plugin's own ignore list.
 *
 * @param enabled - true only once the server has confirmed this viewer is an admin
 * @param lines - how many lines to ask for (the route clamps to 1..1000)
 */
export function useServerLogs(enabled: boolean, lines = SERVER_LOG_DEFAULT_LINES) {
  return useQuery({
    queryKey: [...SERVER_LOGS_QUERY_KEY, lines],
    queryFn: () => apiFetch<ServerLogs>(`/api/admin/server/logs?lines=${lines}`),
    enabled,
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

/**
 * `PUT /api/admin/server/logging` — the debug switch.
 *
 * Applied live on the server (the transport's level is flipped, no restart),
 * and the answer is the fresh deployment view, so it is written straight into
 * that query's cache: the switch and the sentence under it both read from the
 * view, and anything less would leave them showing the old state until the
 * next poll.
 *
 * Refused with 409 while `SUBSHELL_DEBUG_LOGGING` is set; the card renders the
 * switch as a sentence in that case rather than relying on the refusal.
 */
export function useSetDebugLogging() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (debug: boolean) =>
      apiFetch<ServerDeployment>("/api/admin/server/logging", { method: "PUT", body: JSON.stringify({ debug }) }),
    onSuccess: (view) => {
      queryClient.setQueryData(SERVER_DEPLOYMENT_QUERY_KEY, view);
    },
  });
}
